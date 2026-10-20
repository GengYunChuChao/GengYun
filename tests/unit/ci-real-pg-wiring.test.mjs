// GY-I12／GY-I15 真库臂接线守卫：把「脚本在 main 上、却没有任何 workflow 跑过」变成结构性红
//
// 缺口（本片实测，基线 `df043a7`）：
//   `tests/integration/conversations-pg.mjs`（#313）与 `tests/integration/community-pg.mjs`（#296）都在 main，
//   但逐 workflow 检索文件名 **0 命中**——11 个 workflow 谁都不跑它们。于是「真库臂」只存在于本机，
//   CI 上无论它们坏成什么样都不会红。本测试把这条缺口变成会红的断言。
//
// 判类口径（刻意收窄）：只认下面 `MANAGED_SCRIPTS` 这两条——它们**只有真库臂**，没有可替代的替身/内存臂，
// 因此「某个 workflow 的 `run:` 行里出现它」就是唯一有意义的接线证明。其它 `-pg.mjs` 各有自己的
// workflow 或已在 `tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS` 里
// 逐条声明（本文件不重复判它们，也不动那张表）。
//
// 五条判据（每条都有对应反向控制，且反向控制与正向断言**调用同一个**函数）：
//   ① 受管脚本必须出现在某个 `.github/workflows/*.yml` 的 `run:` **命令文本**里
//      （不认注释、不认裸文件名；`run: |` 块标量体里的 `#` 行是 shell 注释，同样不认）；
//   ② 任何 workflow 都不得含「放宽跳过」的开关（`GY_ALLOW_SKIP` / `--allow-skip`）——
//      真库没跑起来必须以 77 红掉，不得被写成绿（口径见 `.pg17/ruling-skip-exit-code-20261020.md`）；
//   ③ **真跑受管脚本的那个 job** 必须真的有 `services.postgres`，且镜像主版本锚定 **17**
//      （防降级到 16 / 防删 service；作用域锚定到 job，⛔ 不看「文件里第一个 `services:`」——
//      前置诱饵 job 就能把那种实现骗成绿）；
//   ④ 该 workflow 的每个 `uses:` 必须固定到 **40 位 SHA**（⛔ 不许写浮标签；口径与仓内其它 workflow 一致）；
//   ⑤ 该 workflow 不得含「吞红」构造（`continue-on-error` / `if:` / 行尾 `|| true`）——
//      真库臂的红是唯一验收信号，吞掉它就等于没有闸门。
//
// 纯静态：只读 `.github/workflows/` 下的文本，⛔ 不起服务、不连 PG、不联网、不写任何文件、不新增依赖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（tests/unit/ → ../..），⛔ 不用 process.cwd()。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = '.github/workflows';
const REAL_PG_WORKFLOW = `${WORKFLOW_DIR}/real-pg-integration.yml`;

/**
 * 受管脚本清单：这两条**只能**用真库证明（没有替身臂可以替代），故必须被某个 workflow 真跑。
 * 增删任何一条＝放宽或收紧门禁，必须同时改 `FROZEN_MANAGED_SCRIPTS` 并更新证据页——刻意留 diff。
 */
const MANAGED_SCRIPTS = Object.freeze([
  'tests/integration/conversations-pg.mjs',
  'tests/integration/community-pg.mjs',
]);

const FROZEN_MANAGED_SCRIPTS = Object.freeze([
  'tests/integration/conversations-pg.mjs',
  'tests/integration/community-pg.mjs',
]);

/**
 * 「放宽跳过」的开关：出现任何一个就说明有人为了让 job 变绿把「未取得」改写成「通过」。
 * 脚本侧这两个开关只在本机开发时用（`--allow-skip` 取 0）；⛔ 永远不得进 workflow。
 */
const FORBIDDEN_ESCAPE_HATCHES = Object.freeze(['GY_ALLOW_SKIP', '--allow-skip']);

/** 真库镜像的主版本：`postgres:17.11` 的 `17`。降级成 16 会让 17 专有行为（视图/迁移）静默失真。 */
const REQUIRED_POSTGRES_MAJOR = '17';

// ── 纯函数：正向断言与反向控制共用同一份逻辑，避免「红的逻辑」与「绿的条件」各写一套 ──────────────

/** 只有 `.yml` / `.yaml` 才是 workflow。 */
export function isWorkflowFile(fileName) {
  return fileName.endsWith('.yml') || fileName.endsWith('.yaml');
}

export function selectWorkflowFiles(fileNames) {
  return fileNames.filter(isWorkflowFile).sort();
}

/**
 * 取出一个 workflow 文本里所有 `run:` 的**命令文本**（内联值 ＋ 其后缩进更深的块行）。
 * `run:` 之前的缩进（含 `- ` 列表前缀）就是块的边界：缩进不深于此的下一行（如 `env:`、下一个 `- `）即结束。
 * **两种注释都不算命令**——否则「注释里提一句脚本名」就能把守卫糊弄绿：
 *   ① YAML 级注释行（`#` 开头的行）；
 *   ② `run: |`／`run: >` 块标量体里的 `#` 行——GitHub 用 bash 执行块内容，那是 **shell 注释、不会执行**。
 * （块标量指示符本身如 `|` 会作为内联值进入命令文本，无害：它不含任何脚本路径。）
 */
export function runCommandTextsOf(source) {
  const lines = source.split('\n');
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const match = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(line);
    if (!match) continue;
    const blockIndent = match[1].length;
    const parts = [];
    const inline = match[2].trim();
    if (inline !== '' && !inline.startsWith('#')) parts.push(inline);
    for (let next = index + 1; next < lines.length; next += 1) {
      const blockLine = lines[next];
      if (blockLine.trim() === '') continue;
      const indent = blockLine.length - blockLine.trimStart().length;
      if (indent <= blockIndent) break;
      index = next;
      // ② 块标量体里的 `#` 行＝shell 注释：跳过内容但**仍推进 index**（否则外层会把它当新行重扫）。
      if (blockLine.trim().startsWith('#')) continue;
      parts.push(blockLine.trim());
    }
    if (parts.length > 0) commands.push(parts.join('\n'));
  }
  return commands;
}

/**
 * 哪些受管脚本**没有**出现在任何 workflow 的 `run:` 命令文本里（升序）。
 * `workflows` 形如 `[{ file, commands }]`：正向断言传磁盘真值，反向控制传内存变异值。
 */
export function missingManagedScripts({ workflows, managed = MANAGED_SCRIPTS }) {
  const wired = new Set();
  for (const workflow of workflows) {
    for (const command of workflow.commands) {
      for (const script of managed) {
        if (command.includes(script)) wired.add(script);
      }
    }
  }
  return managed.filter((script) => !wired.has(script)).sort();
}

/** 宽松跳过开关的命中行（`文件:行号: 开关`），空数组＝干净。 */
export function escapeHatchHits({ file, source }) {
  const hits = [];
  source.split('\n').forEach((line, index) => {
    for (const token of FORBIDDEN_ESCAPE_HATCHES) {
      if (line.includes(token)) hits.push(`${file}:${index + 1}: ${token}`);
    }
  });
  return hits;
}

/** 找到 `key:` 那一行及其缩进更深的后继块（只取第一条）。找不到返回 `null`。 */
function blockAfterKey(source, key) {
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith('#')) continue;
    const match = new RegExp(`^(\\s*(?:-\\s+)?)${key}:\\s*$`).exec(line);
    if (!match) continue;
    const blockIndent = match[1].length;
    const body = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const blockLine = lines[next];
      if (blockLine.trim() === '') continue;
      const indent = blockLine.length - blockLine.trimStart().length;
      if (indent <= blockIndent) break;
      body.push(blockLine);
    }
    return { indent: blockIndent, body };
  }
  return null;
}

/**
 * 真库服务段的问题清单（空数组＝合规）：
 *   ① 缺 `services:` 段；② 缺 `services.postgres`；③ 缺 `image:`；④ 镜像不是 `postgres:<主版本>`；
 *   ⑤ 主版本不是 17。
 */
export function postgresServiceProblems(source, { requiredMajor = REQUIRED_POSTGRES_MAJOR } = {}) {
  const problems = [];
  const services = blockAfterKey(source, 'services');
  if (services === null) {
    problems.push('缺少 `services:` 段：真库服务容器被删掉了（脚本会连不上库并以 77 退出）');
    return problems;
  }
  if (!services.body.some((line) => /^\s+postgres:\s*$/.test(line))) {
    problems.push('`services:` 段里缺少 `postgres:` 服务（镜像与健康检查一并失效）');
    return problems;
  }
  const imageLine = services.body.map((line) => /^\s+image:\s*(['"]?)([^'"\s]+)\1\s*$/.exec(line)).find(Boolean);
  if (imageLine === undefined) {
    problems.push('`services.postgres` 缺少 `image:`（没有镜像就没有真库）');
    return problems;
  }
  const image = imageLine[2];
  const imageMatch = /^postgres:(\d+)/.exec(image);
  if (imageMatch === null) {
    problems.push(`\`services.postgres.image\` 不是 \`postgres:<主版本>\` 形状：${image}`);
    return problems;
  }
  if (imageMatch[1] !== requiredMajor) {
    problems.push(`\`services.postgres.image\` 主版本是 ${imageMatch[1]}，要求 ${requiredMajor}：${image}`);
  }
  return problems;
}

/**
 * 取 `jobs:` 段里每个 job 的 `{ id, body }`（`body` 是该 job 缩进更深的全部行，原样保留缩进）。
 * 用途：把判据③的作用域锚定到**具体 job**——只看「文件里第一个 `services:`」会被诱饵 job 骗过。
 */
export function jobsOf(source) {
  const jobs = blockAfterKey(source, 'jobs');
  if (jobs === null) return [];
  const collected = [];
  let current = null;
  for (const line of jobs.body) {
    if (line.trim() === '') {
      if (current !== null) current.lines.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const key = /^(\s+)([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (indent === jobs.indent + 2 && key !== null) {
      current = { id: key[2], lines: [] };
      collected.push(current);
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  return collected.map((job) => ({ id: job.id, body: job.lines.join('\n') }));
}

/** 哪些 job 的 `run:` **命令文本**里真的出现了受管脚本（判据③的作用域就是它们）。 */
export function jobsRunningManagedScripts(source, { managed = MANAGED_SCRIPTS } = {}) {
  return jobsOf(source).filter((job) => runCommandTextsOf(job.body).some(
    (command) => managed.some((script) => command.includes(script)),
  ));
}

/**
 * 真库服务段的判据（作用域＝**真跑受管脚本的那个 job**，不是文件里第一个 `services:`）。
 * 为什么必须锚定到 job：把两个脚本拆成两个 job 是这个 workflow 最自然的下一步演进；
 * 而在真 job **之前**插一个带 `postgres:17.11` 的诱饵 job，就能让「只取第一个 `services:`」的实现
 * 把真 job 的**镜像降级**或**整段删 services** 判成绿（审查实测 F1／F2，均 6/6 绿）。
 * 判据要能回答两件事：真 job 有 `services.postgres` 吗？真 job 的镜像主版本是 17 吗？
 */
export function postgresJobProblems(source, { managed = MANAGED_SCRIPTS, requiredMajor = REQUIRED_POSTGRES_MAJOR } = {}) {
  const jobs = jobsOf(source);
  if (jobs.length === 0) return ['`jobs:` 段解析不到任何 job（结构变了，判据③失去作用域）'];
  const running = jobsRunningManagedScripts(source, { managed });
  if (running.length === 0) {
    return [`没有任何 job 的 \`run:\` 真跑受管脚本（${managed.join('、')}），无法确认它的 \`services.postgres\` 是否合规`];
  }
  const problems = [];
  for (const job of running) {
    for (const problem of postgresServiceProblems(job.body, { requiredMajor })) {
      problems.push(`job \`${job.id}\`：${problem}`);
    }
  }
  return problems;
}

/**
 * 「吞红」构造的命中行（`文件:行号: 构造`），空数组＝干净。
 * 这一步失败却仍判绿的三种写法：step 级 `continue-on-error:`／`if:`（含 `if: false`）／
 * 命令末尾 `|| true`。真库臂的红是**唯一**的验收信号，任何「吞掉它」的构造都必须拦下。
 * 注释行不算（与判据①同一口径：注释不是命令）。
 */
export function swallowedFailureHits({ file, source }) {
  const hits = [];
  source.split('\n').forEach((line, index) => {
    if (line.trim().startsWith('#')) return;
    const where = `${file}:${index + 1}`;
    if (/^\s*continue-on-error\s*:/.test(line)) hits.push(`${where}: continue-on-error`);
    if (/^\s*(?:-\s+)?if\s*:/.test(line)) hits.push(`${where}: if`);
    if (/\|\|\s*true\b/.test(line)) hits.push(`${where}: || true`);
  });
  return hits;
}

/** 未固定到 40 位 SHA 的 `uses:`（`文件:行号: 引用`），空数组＝全部固定。 */
export function unpinnedUses({ file, source }) {
  const hits = [];
  source.split('\n').forEach((line, index) => {
    if (line.trim().startsWith('#')) return;
    const match = /^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+#.*)?\s*$/.exec(line);
    if (match === null) return;
    if (!/@[0-9a-f]{40}$/.test(match[1])) hits.push(`${file}:${index + 1}: ${match[1]}`);
  });
  return hits;
}

// ── 断言本体：失败消息必须**点名文件**（否则反向控制证明不了「红的时候能定位到谁」） ───────────────

function assertManagedScriptsWired(missing) {
  assert.deepEqual(
    missing,
    [],
    [
      '有受管真库脚本既没有被任何 workflow 的 `run:` 执行，也没有对应的真库臂——',
      '这类脚本坏了 CI 也不会红（「脚本在 main、但没人跑」的静默缺口）：',
      ...missing.map((script) => `  · ${script}`),
      '',
      `改法：在 \`${REAL_PG_WORKFLOW}\`（或另一个带 \`services.postgres\` 的 workflow）里加一步`,
      '`node <脚本>`，不要只写在注释里、也不要只写裸文件名。',
    ].join('\n'),
  );
}

function assertNoEscapeHatches(hits) {
  assert.deepEqual(
    hits,
    [],
    [
      '有 workflow 含「放宽跳过」的开关：真库没跑起来时会把「未取得」改写成「通过」，也就是假绿。',
      '缺库必须以 77 红掉，⛔ 不得在 CI 里放宽：',
      ...hits.map((hit) => `  · ${hit}`),
    ].join('\n'),
  );
}

function assertPostgresServiceHealthy(file, problems) {
  assert.deepEqual(
    problems,
    [],
    [`真库 workflow \`${file}\` 的 \`services.postgres\` 不合格：`, ...problems.map((p) => `  · ${p}`)].join('\n'),
  );
}

function assertActionsPinned(hits) {
  assert.deepEqual(
    hits,
    [],
    [
      '有 workflow 的 `uses:` 没有固定到 40 位 SHA（浮标签会随上游发版改变 CI 语义）：',
      ...hits.map((hit) => `  · ${hit}`),
    ].join('\n'),
  );
}

function assertNoSwallowedFailures(hits) {
  assert.deepEqual(
    hits,
    [],
    [
      '真库 workflow 里有「吞红」构造：这一步失败却仍会被判绿，真库闸门等于没有。',
      '真库臂的红是唯一的验收信号，⛔ 不得用这些写法把它吞掉：',
      ...hits.map((hit) => `  · ${hit}`),
    ].join('\n'),
  );
}

// ── 磁盘真值 ────────────────────────────────────────────────────────────────────────────────

function listWorkflowFilesOnDisk() {
  return selectWorkflowFiles(readdirSync(join(REPO_ROOT, WORKFLOW_DIR))).map((name) => `${WORKFLOW_DIR}/${name}`);
}

function readWorkflow(file) {
  return { file, source: readFileSync(join(REPO_ROOT, file), 'utf8') };
}

function readAllWorkflows() {
  return listWorkflowFilesOnDisk().map((file) => {
    const { source } = readWorkflow(file);
    return { file, source, commands: runCommandTextsOf(source) };
  });
}

// ── 变异辅助（只给反向控制用；全部在**内存**里做，⛔ 不落盘） ────────────────────────────

/** 只替换**最后一次**匹配——「诱饵 + 真 job」里必须只动真 job 的镜像行。 */
function replaceLast(source, re, replacement) {
  const matches = [...source.matchAll(re)];
  assert.ok(matches.length >= 1, `变异找不到目标：${re}`);
  const last = matches[matches.length - 1];
  return source.slice(0, last.index) + replacement + source.slice(last.index + last[0].length);
}

/** 在 `jobs:` 之后插一个**自带合规 `postgres:17.11`** 的诱饵 job（模拟「先把诱饵放前面」）。 */
function withDecoyJob(source) {
  const decoy = [
    '  zz-decoy:',
    '    runs-on: ubuntu-24.04',
    '    services:',
    '      postgres:',
    '        image: postgres:17.11',
    '    steps:',
    '      - run: echo noop',
  ].join('\n');
  const mutated = source.replace(/^jobs:\n/m, `jobs:\n${decoy}\n`);
  assert.notEqual(mutated, source, '诱饵 job 必须真的插进文本');
  return mutated;
}

/** 删掉指定 job **自己的** `services:` 段（只在该 job 的行范围内动手，⛔ 不碰别的 job 的同名段）。 */
function withoutJobServices(source, jobId) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^ {2}${jobId}:\\s*$`).test(line));
  assert.ok(start >= 0, `变异找不到 job \`${jobId}\``);
  const kept = [];
  let dropping = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > start && /^ {0,2}\S/.test(line)) dropping = false;
    if (index >= start && !dropping && /^ {4}services:\s*$/.test(line)) {
      dropping = true;
      continue;
    }
    if (dropping) {
      if (line.trim() === '' || /^ {5,}\S/.test(line)) continue;
      dropping = false;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

// ── 用例 ────────────────────────────────────────────────────────────────────────────────────

test('前向①：两个受管真库脚本都被某个 workflow 的 `run:` 真跑', () => {
  const workflows = readAllWorkflows();

  assertManagedScriptsWired(missingManagedScripts({ workflows }));

  // 反空转：扫到的 workflow 数、命令块数、受管清单都必须非空——否则「什么都没扫」也会绿。
  assert.ok(workflows.length >= 11, `只扫到 ${workflows.length} 个 workflow，判据可能已失效`);
  assert.ok(
    workflows.reduce((sum, workflow) => sum + workflow.commands.length, 0) >= 5,
    '扫到的 `run:` 命令块太少，解析口径可能已失效',
  );
  assert.ok(MANAGED_SCRIPTS.length >= 2, '受管清单为空或塌缩，本守卫会变成永远绿');
  // 冻结：增删受管脚本＝改门禁口径，必须留下可审的 diff。
  assert.deepEqual([...MANAGED_SCRIPTS].sort(), [...FROZEN_MANAGED_SCRIPTS].sort(), '受管脚本清单被改动但未同步冻结清单');
  // 受管脚本必须真实存在（改名/删除后这条会红，逼人一并更新清单而不是留个悬空引用）。
  for (const script of MANAGED_SCRIPTS) {
    assert.doesNotThrow(() => readFileSync(join(REPO_ROOT, script), 'utf8'), `受管脚本 ${script} 不存在`);
  }
});

test('反向控制①：删掉某脚本的 `run:` 行，同一断言必须红并点名它', () => {
  const workflows = readAllWorkflows();
  const target = 'tests/integration/conversations-pg.mjs';
  const witness = 'tests/integration/community-pg.mjs';
  const real = workflows.find((workflow) => workflow.file === REAL_PG_WORKFLOW);
  assert.ok(real !== undefined, `磁盘上找不到 ${REAL_PG_WORKFLOW}（本片的核心交付物）`);

  // 只在内存里变异：删掉提到目标脚本的那一行（模拟「有人把这一步删了」）。
  const mutatedSource = real.source
    .split('\n')
    .filter((line) => !line.includes(`node ${target}`))
    .join('\n');
  assert.notEqual(mutatedSource, real.source, '变异必须真的改到文本（否则反向控制是空转）');
  assert.ok(mutatedSource.includes(witness), '变异只许打断一个脚本，另一个必须仍是绿的');

  const mutated = workflows.map((workflow) =>
    workflow.file === REAL_PG_WORKFLOW
      ? { ...workflow, source: mutatedSource, commands: runCommandTextsOf(mutatedSource) }
      : workflow,
  );
  assert.deepEqual(
    missingManagedScripts({ workflows: mutated }),
    [target],
    '删掉 run 行后必须且只能点名被删的那个脚本',
  );
  assert.throws(
    () => assertManagedScriptsWired(missingManagedScripts({ workflows: mutated })),
    (error) => error.message.includes(target),
    '删掉 run 行后同一断言必须失败，且失败消息要点名该脚本',
  );

  // 不永红：只把脚本名写进注释也救不了（注释不是命令）。
  const commentOnly = [{
    file: REAL_PG_WORKFLOW,
    commands: runCommandTextsOf(`jobs:\n  x:\n    steps:\n      # - run: node ${target}\n      - run: echo hi\n`),
  }];
  assert.deepEqual(
    missingManagedScripts({ workflows: commentOnly, managed: [target] }),
    [target],
    '注释里的 `run:` 不算接线（否则守卫可被一句注释糊弄）',
  );
  // 而真的写成 `run:` 命令就立刻转绿（证明「接线」这个出口真的可走通）。
  const wired = [{
    file: REAL_PG_WORKFLOW,
    commands: runCommandTextsOf(`jobs:\n  x:\n    steps:\n      - run: node ${target}\n`),
  }];
  assert.deepEqual(missingManagedScripts({ workflows: wired, managed: [target] }), []);
});

test('前向②：任何 workflow 都不得含「放宽跳过」开关', () => {
  const hits = readAllWorkflows().flatMap((workflow) => escapeHatchHits(workflow));
  assertNoEscapeHatches(hits);
});

test('反向控制②：往 workflow 里加 `GY_ALLOW_SKIP` 或 `--allow-skip`，同一断言必须红并点名文件', () => {
  const workflows = readAllWorkflows();
  assertNoEscapeHatches(workflows.flatMap((workflow) => escapeHatchHits(workflow)));

  for (const token of FORBIDDEN_ESCAPE_HATCHES) {
    // 只在内存里注入：模拟「有人为了让 job 变绿加了一行开关」。
    const mutatedSource = `${workflows.find((workflow) => workflow.file === REAL_PG_WORKFLOW).source}\n# ${token}\n`;
    const hits = escapeHatchHits({ file: REAL_PG_WORKFLOW, source: mutatedSource });
    assert.equal(hits.length, 1, `注入 ${token} 后必须正好命中一处`);
    assert.ok(hits[0].includes(REAL_PG_WORKFLOW), `失败信息必须点名文件（${token}）`);
    assert.throws(
      () => assertNoEscapeHatches(hits),
      (error) => error.message.includes(token),
      `注入 ${token} 后同一断言必须失败，且消息里要出现该开关`,
    );
  }

  // 不误伤：语义相反的合法文字（「不得放宽」）不得被当成开关。
  assert.deepEqual(escapeHatchHits({ file: REAL_PG_WORKFLOW, source: '# 缺库必须以 77 红掉，不得放宽\n' }), []);
});

test('前向③：真 job 有 `services.postgres`，镜像主版本锚定 17，且 `uses:` 全部固定 SHA', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);

  assertPostgresServiceHealthy(REAL_PG_WORKFLOW, postgresJobProblems(source));
  assertActionsPinned(unpinnedUses({ file: REAL_PG_WORKFLOW, source }));

  // 反空转：必须真的解析到 job / 镜像行 / uses 行，否则上面的「无问题」只是没解析到东西。
  assert.ok(jobsOf(source).length >= 1, `${REAL_PG_WORKFLOW} 解析不到任何 job，判据③失去作用域`);
  assert.ok(
    jobsRunningManagedScripts(source).length >= 1,
    '没有任何 job 被判定为「真跑受管脚本」，判据③等于没扫到东西',
  );
  assert.match(source, /^\s+image:\s*postgres:17/m, `${REAL_PG_WORKFLOW} 里找不到 \`image: postgres:17…\``);
  assert.match(source, /(?:^|\s)uses:\s/m, `${REAL_PG_WORKFLOW} 里找不到任何 \`uses:\``);
  // 真库 job 必须在 runner 上有 psql 可用（建专用空库那一步依赖它，与 `consent-grant-postgres.yml` 同构）。
  const commands = runCommandTextsOf(source);
  assert.ok(commands.some((command) => command.includes('psql')), '真库 workflow 必须在某个 `run:` 里用 psql 建专用库');
  assert.ok(commands.some((command) => command.includes('npm ci')), '真库 workflow 必须装依赖');
});

test('前向④：真库 workflow 不得含「吞红」构造（`continue-on-error` / `if:` / `|| true`）', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  assertNoSwallowedFailures(swallowedFailureHits({ file: REAL_PG_WORKFLOW, source }));

  // 反向控制（内存变异）：三种吞红写法各自必须被判红，并点名文件与行号。
  for (const [label, line] of [
    ['continue-on-error', '        continue-on-error: true'],
    ['if', '        if: false'],
    ['or-true', '      - run: node tests/integration/community-pg.mjs || true'],
  ]) {
    const mutated = `${source}\n${line}\n`;
    const hits = swallowedFailureHits({ file: REAL_PG_WORKFLOW, source: mutated });
    assert.equal(hits.length, 1, `注入 ${label} 后必须正好命中一处`);
    assert.ok(hits[0].includes(REAL_PG_WORKFLOW), `失败信息必须点名文件（${label}）`);
    assert.throws(
      () => assertNoSwallowedFailures(hits),
      (error) => error.message.includes(REAL_PG_WORKFLOW) && error.message.includes('吞红'),
      `注入 ${label} 后同一断言必须失败，且消息点名文件`,
    );
  }
  // 不误伤：注释里提到这些写法不算（注释不是命令）。
  assert.deepEqual(
    swallowedFailureHits({ file: REAL_PG_WORKFLOW, source: '# 本 job 不得用 continue-on-error / if: / || true\n' }),
    [],
  );
});

test('反向控制③：镜像降到 16 / 删掉 services / 换成浮标签，同一断言必须红', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  assertPostgresServiceHealthy(REAL_PG_WORKFLOW, postgresJobProblems(source));

  // ① 主版本降级：17.11 → 16.4。
  const downgraded = source.replace(/image:\s*postgres:17[^\s]*/, 'image: postgres:16.4');
  assert.notEqual(downgraded, source, '变异必须真的改到镜像行');
  const downgradeProblems = postgresJobProblems(downgraded);
  assert.equal(downgradeProblems.length, 1, '降级必须且只能报一条问题');
  assert.ok(downgradeProblems[0].includes('16'), '问题描述必须写出实际主版本');
  assert.throws(
    () => assertPostgresServiceHealthy(REAL_PG_WORKFLOW, downgradeProblems),
    (error) => error.message.includes(REAL_PG_WORKFLOW),
    '降级后同一断言必须失败，且消息点名文件',
  );

  // ② 删掉**真 job 自己的** `services:` 段（模拟「有人嫌 CI 慢把 service 去掉」）。
  const withoutServices = withoutJobServices(source, 'real-pg-17-11');
  assert.notEqual(withoutServices, source, '变异必须真的删到 services 段');
  assert.ok(
    postgresJobProblems(withoutServices).length > 0,
    '删掉 service 段后必须报问题（否则 `services` 缺失可以被静默忽略）',
  );
  assert.throws(
    () => assertPostgresServiceHealthy(REAL_PG_WORKFLOW, postgresJobProblems(withoutServices)),
    (error) => error.message.includes(REAL_PG_WORKFLOW),
    '删掉 service 段后同一断言必须失败，且消息点名文件',
  );

  // ③ 浮标签：把固定 SHA 换成 `@v4`。
  const floating = source.replace(/uses:\s*actions\/checkout@[0-9a-f]{40}/, 'uses: actions/checkout@v4');
  assert.notEqual(floating, source, '变异必须真的改到 uses 行');
  const floatingHits = unpinnedUses({ file: REAL_PG_WORKFLOW, source: floating });
  assert.equal(floatingHits.length, 1, '换成浮标签后必须且只能命中一处');
  assert.throws(
    () => assertActionsPinned(floatingHits),
    (error) => error.message.includes('actions/checkout@v4'),
    '浮标签必须让同一断言失败，且消息点名那条引用',
  );
});

test('反向控制①b：`run: |` 块体里把调用写成 shell 注释，判据①必须判红', () => {
  const target = 'tests/integration/conversations-pg.mjs';
  const witness = 'tests/integration/community-pg.mjs';
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  assertManagedScriptsWired(missingManagedScripts({ workflows: readAllWorkflows() }));

  // ① 合成形态：块标量体里只有 `# node <脚本>` + `echo hi` ⇒ 不得被当成接线。
  const commentedBlock = [
    'jobs:',
    '  real-pg-17-11:',
    '    runs-on: ubuntu-24.04',
    '    steps:',
    '      - run: |',
    `          # node ${target}`,
    '          echo hi',
  ].join('\n');
  const commentedCommands = runCommandTextsOf(commentedBlock);
  assert.equal(
    commentedCommands.some((command) => command.includes(target)),
    false,
    '`run: |` 块体里的 `#` 行是 shell 注释，不得进入命令文本',
  );
  const missing = missingManagedScripts({
    workflows: [{ file: REAL_PG_WORKFLOW, commands: commentedCommands }],
    managed: [target],
  });
  assert.deepEqual(missing, [target], '块内注释不得算接线');
  assert.throws(
    () => assertManagedScriptsWired(missing),
    (error) => error.message.includes(target),
    '块内注释未接线时同一断言必须失败，且消息点名该脚本',
  );

  // ② 不永红：把块里的调用**取消注释**（真成一行命令）⇒ 判据①转绿。
  const uncommentedBlock = commentedBlock.replace(`# node ${target}`, `node ${target}`);
  assert.deepEqual(
    missingManagedScripts({
      workflows: [{ file: REAL_PG_WORKFLOW, commands: runCommandTextsOf(uncommentedBlock) }],
      managed: [target],
    }),
    [],
    '块体里真写成一行命令时必须算接线（证明这条反向控制的绿出口真的存在）',
  );

  // ③ 对**真文件**做同一改造：把会话链那一行换成「只含 shell 注释的 `run: |` 块」⇒ 必须点名该脚本。
  const mutatedSource = source
    .split('\n')
    .map((line) => (line.includes(`node ${target}`)
      ? ['      - run: |', `          # node ${target}`, '          echo hi'].join('\n')
      : line))
    .join('\n');
  assert.notEqual(mutatedSource, source, '变异必须真的改到真 workflow 的那一行');
  assert.ok(mutatedSource.includes(witness), '变异只许打断一个脚本，另一个必须仍是绿的');
  const mutatedMissing = missingManagedScripts({
    workflows: [{ file: REAL_PG_WORKFLOW, commands: runCommandTextsOf(mutatedSource) }],
    managed: [target, witness],
  });
  assert.deepEqual(mutatedMissing, [target], '对真文件做同样的「注释化」后必须且只能点名被注释的那个脚本');
  assert.throws(
    () => assertManagedScriptsWired(mutatedMissing),
    (error) => error.message.includes(target),
    '真文件被注释化后同一断言必须失败，且消息点名该脚本',
  );
});

test('反向控制④：真 job 前插**合规诱饵 job**，真 job 镜像降到 16.4 ⇒ 判据③必须判红（锚定真 job）', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  assertPostgresServiceHealthy(REAL_PG_WORKFLOW, postgresJobProblems(source));

  const withDecoy = withDecoyJob(source);
  const decoy = jobsOf(withDecoy).find((job) => job.id === 'zz-decoy');
  assert.ok(decoy !== undefined, '诱饵 job 没被解析到（判据③的作用域解析坏了）');
  // 诱饵自身合规 ⇒「只看文件里第一个 `services:`」的实现会读到它并判绿——这正是要堵的假绿通道。
  assert.deepEqual(
    postgresServiceProblems(decoy.body),
    [],
    '诱饵 job 自身必须合规，否则这条反向控制没有证明力',
  );
  // 只插诱饵、真 job 不动 ⇒ 仍绿（不误伤）。
  assertPostgresServiceHealthy(REAL_PG_WORKFLOW, postgresJobProblems(withDecoy));

  // 只降级**最后一次** `postgres:17.11`（＝真 job 的镜像），诱饵保持 17.11。
  const decoyPlusDowngrade = replaceLast(withDecoy, /image:\s*postgres:17\.11/g, 'image: postgres:16.4');
  assert.notEqual(decoyPlusDowngrade, withDecoy, '变异必须真的改到真 job 的镜像行');
  assert.ok(decoyPlusDowngrade.includes('image: postgres:17.11'), '诱饵的 17.11 必须保留（否则红可能来自诱饵）');
  assert.deepEqual(
    postgresServiceProblems(jobsOf(decoyPlusDowngrade).find((job) => job.id === 'zz-decoy').body),
    [],
    '诱饵仍必须合规：这个红只能来自真 job',
  );

  const problems = postgresJobProblems(decoyPlusDowngrade);
  assert.equal(problems.length, 1, '降级必须且只能报一条问题（否则红可能来自诱饵）');
  assert.ok(problems[0].includes('real-pg-17-11'), '失败消息必须点名**真 job**');
  assert.ok(problems[0].includes('16'), '失败消息必须写出实际主版本');
  assert.throws(
    () => assertPostgresServiceHealthy(REAL_PG_WORKFLOW, problems),
    (error) => error.message.includes(REAL_PG_WORKFLOW) && error.message.includes('real-pg-17-11'),
    '诱饵 + 真 job 降级后同一断言必须失败，且消息点名文件与真 job',
  );
});

test('反向控制⑤：真 job 前插**合规诱饵 job**，真 job 删掉 `services` ⇒ 判据③必须判红（锚定真 job）', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  const withDecoy = withDecoyJob(source);
  const decoyMinusRealServices = withoutJobServices(withDecoy, 'real-pg-17-11');
  assert.notEqual(decoyMinusRealServices, withDecoy, '变异必须真的删到真 job 的 services 段');

  // 诱饵的 `services` 必须原样保留且仍合规 ⇒ 这个红只能来自「真 job 没有 services」。
  const decoy = jobsOf(decoyMinusRealServices).find((job) => job.id === 'zz-decoy');
  assert.ok(decoy !== undefined, '诱饵 job 没被解析到');
  assert.deepEqual(
    postgresServiceProblems(decoy.body),
    [],
    '诱饵必须仍保留合规的 services，否则这条反向控制没有证明力',
  );

  const problems = postgresJobProblems(decoyMinusRealServices);
  assert.equal(problems.length, 1, '删 services 必须且只能报一条问题（否则红可能来自诱饵）');
  assert.ok(problems[0].includes('real-pg-17-11'), '失败消息必须点名**真 job**');
  assert.ok(problems[0].includes('services'), '失败消息必须指出缺的是 services');
  assert.throws(
    () => assertPostgresServiceHealthy(REAL_PG_WORKFLOW, problems),
    (error) => error.message.includes(REAL_PG_WORKFLOW) && error.message.includes('real-pg-17-11'),
    '诱饵 + 真 job 删 services 后同一断言必须失败，且消息点名文件与真 job',
  );
});
