// 机器判据（R67-D01）：`ci-integration-chain-structure.test.mjs` 的未接线白名单理由必须「按四类说真话」。
//
// 背景：判据 4 只认 `package.json` 的 `test:integration:http` 回环链，不认识 workflow —— 所以真被
// `.github/workflows/*.yml` 某个 job 的 `run:` 跑到的脚本**仍然**要留在白名单里（这不是失职）。
// 代价是这 53 条 `reason` 曾经大面积写成同一句「需真实 PG，留作后续接线」：它把四种完全不同的东西
// 混成了一句话——真被 CI 跑的、driver/fixture/反向控制这类根本不是门禁入口的、真缺口、纯 HTTP/内存桩。
// 本文件把「说真话」变成机器可判的形状：
//
//   1) 每条 `reason` 必须以四类前缀之一开头；
//   2) `已接线（workflow）：` 必须写出 `<workflow 文件>#<job 键>`，且**该 job 键真的存在于那份 yml**
//      （从 yml 文本解析 job 键，⛔ 不硬编码任何 job 名）；
//   3) `已接线（workflow）：` 还必须与 workflow 的 `run:` 事实**双向一致**：登记成已接线的脚本，必须
//      真被它声称的那个 job 跑；反过来，被任何 workflow 的 `run:` 跑到的白名单脚本，必须登记成已接线；
//   4) `非门禁入口：` 与 `未接线（真缺口）：` 必须各自写清「怎么被调用／缺什么」，且都必须不被任何
//      workflow 的 `run:` 跑到（把它们说成已接线，或把已接线的说成它们，都要红）。
//
// 为什么判据放在**新文件**而不是追加到 `ci-integration-chain-structure.test.mjs`：
//   `docs/verification/**` 里有手写行号锚点指着那个文件的区间（例：`…:172-192`、`…:594`），
//   追加子测试会让它的总行数从 738 变掉、锚点集体漂移。本文件只**读**那个文件的源文本 + 各份 yml，
//   不改它们，也不重复注册它们的测试。

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const STRUCTURE_TEST = join(REPO_ROOT, 'tests', 'unit', 'ci-integration-chain-structure.test.mjs');
const WORKFLOW_ROOT = join(REPO_ROOT, '.github', 'workflows');

/** 白名单条目数：与 `ci-integration-chain-structure.test.mjs` 的「恰好 53 条」是同一个数。 */
const ENTRY_COUNT = 53;

const WIRED = '已接线（workflow）：';
const NON_GATE = '非门禁入口：';
const GAP = '未接线（真缺口）：';
const NO_DB = '不需要真库：';
const PREFIXES = Object.freeze([WIRED, NON_GATE, GAP, NO_DB]);

// ---------------------------------------------------------------------------------------------
// 白名单解析：只认 `ci-integration-chain-structure.test.mjs` 里那个数组的形状
// （`path: '...'` + `reason:` 由若干 `'...'` 段拼接）。解析不全会抛，⛔ 不会静默跳过。
// ---------------------------------------------------------------------------------------------

function parseDeclarations(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.includes('const UNWIRED_DECLARATIONS = Object.freeze(['));
  assert.notEqual(start, -1, '没找到 UNWIRED_DECLARATIONS 数组：判据已与实现脱钩，需同步本文件');

  const end = lines.findIndex((line, index) => index > start && line === ']);');
  assert.notEqual(end, -1, 'UNWIRED_DECLARATIONS 数组没有以 `]);` 收尾：解析失败');

  const declarations = [];
  let current = null;
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i];
    const pathMatch = /^    path: '([^']+)',$/.exec(line);
    if (pathMatch) {
      assert.equal(current, null, `第 ${i + 1} 行的 path 出现在上一条目收尾之前`);
      current = { path: pathMatch[1], reason: '', line: i + 1 };
      continue;
    }
    const first = /^    reason: '(.*)'$/.exec(line);
    const more = /^      \+ '(.*)'$/.exec(line);
    const segment = first ? first[1] : more ? more[1] : null;
    if (segment !== null) {
      assert.notEqual(current, null, `第 ${i + 1} 行的 reason 前面没有 path`);
      assert.ok(
        !segment.includes('\\'),
        `第 ${i + 1} 行的 reason 段里有反斜杠转义，本解析器不支持；请改成不带转义的写法`,
      );
      current.reason += segment;
      continue;
    }
    if (/^  \},?$/.test(line)) {
      assert.notEqual(current, null, `第 ${i + 1} 行在条目之外收尾`);
      assert.ok(current.reason.length > 0, `${current.path} 的 reason 是空的`);
      declarations.push(current);
      current = null;
    }
  }
  assert.equal(current, null, '最后一个条目没有收尾');
  return declarations;
}

// ---------------------------------------------------------------------------------------------
// workflow 解析：从 yml 文本里解出 `jobs:` 下的 job 键，以及每个 job 的 `run:` 命令文本。
// 口径与 `ci-real-pg-wiring.test.mjs` 的 `jobsOf` / `runCommandTextsOf` 一致（同一件事不另立一套）。
// ---------------------------------------------------------------------------------------------

/** 解析一份 workflow 源文本 ⇒ Map<job 键, job 体文本>。 */
function jobsOf(source) {
  const jobs = new Map();
  const lines = source.split('\n');
  let insideJobs = false;
  let job = null;
  let body = [];

  const flush = () => {
    if (job !== null) jobs.set(job, body.join('\n'));
    job = null;
    body = [];
  };

  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      insideJobs = true;
      continue;
    }
    if (!insideJobs) continue;
    // `jobs:` 之后出现顶格行（另一个顶层键或文件尾注释块）⇒ jobs 段结束。
    if (/^\S/.test(line)) {
      flush();
      insideJobs = false;
      continue;
    }
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key) {
      flush();
      job = key[1];
      body = [line];
      continue;
    }
    if (job !== null) body.push(line);
  }
  flush();
  return jobs;
}

/** 解出 job 体里所有 `run:` 的命令文本（块标量去缩进、去纯注释行；单行 `run:` 原样取）。 */
function runCommandTextsOf(jobSource) {
  const lines = jobSource.split('\n');
  const commands = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!head) continue;
    const indent = head[1].length;
    const inline = head[2];
    if (inline === '' || inline === '|' || inline === '>' || inline === '|-' || inline === '>-') {
      const block = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j];
        if (line.trim() === '') continue;
        const lineIndent = line.length - line.trimStart().length;
        if (lineIndent <= indent) break;
        const text = line.trim();
        // 块标量里的 `#` 行是注释，不是命令。
        if (text.startsWith('#')) continue;
        block.push(text);
      }
      if (block.length > 0) commands.push(block.join('\n'));
      continue;
    }
    if (inline.startsWith('#')) continue;
    commands.push(inline);
  }
  return commands;
}

/** 从命令文本里取「真被 node 执行的脚本」集合（只认 `node [--flag] tests/integration/x.mjs`）。 */
function scriptsRunIn(commandText) {
  const found = new Set();
  const pattern = /node\s+(?:--[A-Za-z0-9-]+\s+)*(?:\.\/)?(tests\/integration\/[A-Za-z0-9._-]+\.mjs)/g;
  for (const match of commandText.matchAll(pattern)) found.add(match[1]);
  return found;
}

/** 读全部 workflow ⇒ [{ file: '.github/workflows/x.yml', jobs: Map<job, Map<脚本, true>> }]。 */
function loadWorkflows() {
  const files = readdirSync(WORKFLOW_ROOT)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  assert.ok(files.length > 0, '没扫到任何 workflow：判据会假绿，直接红');
  return files.map((name) => {
    const source = readFileSync(join(WORKFLOW_ROOT, name), 'utf8');
    const jobs = new Map();
    for (const [job, body] of jobsOf(source)) {
      const scripts = new Set();
      for (const command of runCommandTextsOf(body)) {
        for (const script of scriptsRunIn(command)) scripts.add(script);
      }
      jobs.set(job, scripts);
    }
    return { file: `.github/workflows/${name}`, jobs };
  });
}

// ---------------------------------------------------------------------------------------------
// 审计：给定白名单源文本 + workflow 事实，返回问题清单（空数组 = 全绿）。
// 判别力自证直接复用这个函数（改了措辞/改了 job 名都必须产出问题），保证「红」是同一套判据给的。
// ---------------------------------------------------------------------------------------------

const WORKFLOW_REF = /`?\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)#([A-Za-z0-9._-]+)`?/g;

function audit({ source, workflows }) {
  const problems = [];
  const declarations = parseDeclarations(source);

  // 真跑集合：脚本 ⇒ 跑它的 [workflow#job] 列表（全仓口径，不限白名单）。
  const runsBy = new Map();
  for (const { file, jobs } of workflows) {
    for (const [job, scripts] of jobs) {
      for (const script of scripts) {
        if (!runsBy.has(script)) runsBy.set(script, []);
        runsBy.get(script).push(`${file}#${job}`);
      }
    }
  }

  if (declarations.length !== ENTRY_COUNT) {
    problems.push(`白名单条目数 ${declarations.length} ≠ ${ENTRY_COUNT}`);
  }

  const counts = { [WIRED]: 0, [NON_GATE]: 0, [GAP]: 0, [NO_DB]: 0 };

  for (const { path, reason, line } of declarations) {
    const where = `${path}（第 ${line} 行）`;
    const prefix = PREFIXES.find((candidate) => reason.startsWith(candidate));
    if (!prefix) {
      problems.push(`${where}：reason 没有四类前缀之一（当前开头「${reason.slice(0, 16)}」）`);
      continue;
    }
    counts[prefix] += 1;

    const runnerJobs = runsBy.get(path) ?? [];

    if (prefix === WIRED) {
      const refs = [...reason.matchAll(WORKFLOW_REF)].map((match) => ({ file: match[1], job: match[2] }));
      if (refs.length === 0) {
        problems.push(`${where}：说已接线，却没写出「<workflow 文件>#<job 键>」`);
        continue;
      }
      if (runnerJobs.length === 0) {
        problems.push(`${where}：说已接线，但没有任何 workflow 的 run: 跑到它`);
        continue;
      }
      const matched = refs.some((ref) => {
        const workflow = workflows.find((item) => item.file === `.github/workflows/${ref.file}`);
        if (!workflow) {
          problems.push(`${where}：引用的 workflow 文件不存在（${ref.file}）`);
          return false;
        }
        if (!workflow.jobs.has(ref.job)) {
          problems.push(`${where}：引用的 job 键在 ${ref.file} 里不存在（${ref.job}）`);
          return false;
        }
        return workflow.jobs.get(ref.job).has(path);
      });
      if (!matched && refs.every((ref) => {
        const workflow = workflows.find((item) => item.file === `.github/workflows/${ref.file}`);
        return workflow !== undefined && workflow.jobs.has(ref.job);
      })) {
        problems.push(`${where}：声称的 job 没有在 run: 里跑它（真跑它的是 ${runnerJobs.join('、')}）`);
      }
      continue;
    }

    // 其余三类都必须「不被任何 workflow 的 run: 跑到」，否则分类本身就是在说假话。
    if (runnerJobs.length > 0) {
      problems.push(`${where}：说的是「${prefix}」，但 ${runnerJobs.join('、')} 真在跑它`);
    }

    if (prefix === NON_GATE) {
      // 必须写出它实际怎么被调用：至少引一个仓里真实存在、且正文真提到这个脚本的文件。
      const cited = [...reason.matchAll(/`?((?:tests|tools|docs|packages|apps|services)\/[A-Za-z0-9._/-]+)`?/g)]
        .map((match) => match[1]);
      const basename = path.split('/').pop();
      const reproducible = cited.some((candidate) => {
        const absolute = join(REPO_ROOT, candidate);
        try {
          return readFileSync(absolute, 'utf8').includes(basename);
        } catch {
          return false;
        }
      });
      if (!reproducible) {
        problems.push(`${where}：说非门禁入口，却没引到任何真实提到它的调用方文件`);
      }
    }

    if (prefix === GAP && !reason.includes('缺')) {
      problems.push(`${where}：说真缺口，却没写清缺什么`);
    }
  }

  // 已接线条数必须等于「白名单里真被某个 workflow 的 run: 跑到的脚本数」——双向相等。
  const wiredByFact = declarations.filter(({ path }) => (runsBy.get(path) ?? []).length > 0).length;
  if (counts[WIRED] !== wiredByFact) {
    problems.push(`已接线条数 ${counts[WIRED]} ≠ 真被 workflow run: 跑到的白名单脚本数 ${wiredByFact}`);
  }
  // 下界：本片树上真库 workflow 的臂远多于 8 条（R67-C/C3 的两个 admin job 就 8 条），
  // 这里只钉「不可能退化成一刀切」的下界；上界由上面的双向相等负责，⛔ 不用写死 49。
  if (counts[WIRED] < 8) {
    problems.push(`已接线条数 ${counts[WIRED]} < 8：连 R67-C/C3 接的 8 条 admin 臂都没认出来`);
  }
  // 非门禁入口 ≥ 1：driver／fixture／反向控制／需要外部参数的脚本永远存在，退化成一刀切就红。
  // `未接线（真缺口）` 这一类的条数由事实决定（R67-D01 实测为 0：53 条里没有被漏掉的），
  // 故此处不钉 ≥1——钉了就得编造一条假缺口；它仍受上面的「不被任何 run: 跑到」与「写清缺什么」约束。
  if (counts[NON_GATE] < 1) {
    problems.push('非门禁入口 0 条：driver／fixture／反向控制被一刀切成了别的类');
  }
  const total = PREFIXES.reduce((sum, prefix) => sum + counts[prefix], 0);
  if (total !== declarations.length) {
    problems.push(`四类计数合计 ${total} ≠ 条目数 ${declarations.length}`);
  }

  return { problems, declarations, counts, wiredByFact };
}

function auditCurrentTree() {
  return audit({
    source: readFileSync(STRUCTURE_TEST, 'utf8'),
    workflows: loadWorkflows(),
  });
}

test('未接线白名单理由：四类前缀、job 名从 yml 解析、双向一致', async (t) => {
  const { problems } = auditCurrentTree();
  assert.deepEqual(problems, [], `白名单理由与事实不符：\n  - ${problems.join('\n  - ')}`);

  await t.test('① 每条 reason 都以四类前缀之一开头', () => {
    const declarations = parseDeclarations(readFileSync(STRUCTURE_TEST, 'utf8'));
    assert.equal(declarations.length, ENTRY_COUNT);
    for (const { path, reason } of declarations) {
      assert.ok(
        PREFIXES.some((prefix) => reason.startsWith(prefix)),
        `${path} 的 reason 开头不是四类前缀之一：「${reason.slice(0, 16)}」`,
      );
    }
  });

  await t.test('② 已接线的 job 键必须真存在于 yml（从文本解析，不硬编码）', () => {
    const source = readFileSync(STRUCTURE_TEST, 'utf8');
    const workflows = loadWorkflows();
    const jobKeys = new Set();
    for (const { file, jobs } of workflows) {
      for (const job of jobs.keys()) jobKeys.add(`${file}#${job}`);
    }
    let checked = 0;
    for (const { path, reason } of parseDeclarations(source)) {
      if (!reason.startsWith(WIRED)) continue;
      const refs = [...reason.matchAll(WORKFLOW_REF)].map((match) => `.github/workflows/${match[1]}#${match[2]}`);
      assert.ok(refs.length > 0, `${path} 说已接线，却没写 job 键`);
      for (const ref of refs) {
        assert.ok(jobKeys.has(ref), `${path} 引用的 job 不存在：${ref}`);
        checked += 1;
      }
    }
    assert.ok(checked >= 8, `只校验到 ${checked} 个 job 引用，太少`);
  });

  await t.test('③ 非门禁入口不得被任何 workflow 的 run: 跑到，且写明调用方', () => {
    const source = readFileSync(STRUCTURE_TEST, 'utf8');
    const workflows = loadWorkflows();
    const runSet = new Set();
    for (const { jobs } of workflows) for (const scripts of jobs.values()) for (const script of scripts) runSet.add(script);
    const nonGate = parseDeclarations(source).filter(({ reason }) => reason.startsWith(NON_GATE));
    assert.ok(nonGate.length >= 1);
    for (const { path } of nonGate) assert.ok(!runSet.has(path), `${path} 其实被 workflow 跑了，不该登记成非门禁入口`);
  });

  await t.test('④ 已接线条数 = 真被 run: 跑到的白名单脚本数（另钉 ≥8 下界）', () => {
    const { counts, wiredByFact } = auditCurrentTree();
    assert.equal(counts[WIRED], wiredByFact);
    assert.ok(counts[WIRED] >= 8);
  });

  await t.test('⑤ 判别力自证：reason 改回旧措辞「需真实 PG」⇒ 红', () => {
    const source = readFileSync(STRUCTURE_TEST, 'utf8');
    const target = parseDeclarations(source)[0];
    const mutated = source.replace(
      /(    reason: ')[^']*'([\s\S]*?)(\n  \},)/,
      '$1需真实 PG，留作后续接线。\'\n    // 旧措辞$3',
    );
    assert.notEqual(mutated, source, '反例没改到源文本');
    const { problems } = audit({ source: mutated, workflows: loadWorkflows() });
    assert.ok(problems.length > 0, '旧措辞「需真实 PG」应该红，却全绿——判据失去判别力');
    assert.ok(
      problems.some((problem) => problem.includes(target.path) || problem.includes('前缀')),
      `红的原因不对：${problems.join('；')}`,
    );
  });

  await t.test('⑥ 判别力自证：job 名改成 no-such-job ⇒ 红', () => {
    const source = readFileSync(STRUCTURE_TEST, 'utf8');
    const mutated = source.replace(/#real-pg-17-11/g, '#no-such-job');
    assert.notEqual(mutated, source, '反例没改到源文本');
    const { problems } = audit({ source: mutated, workflows: loadWorkflows() });
    assert.ok(problems.length > 0, '把 job 改成 no-such-job 应该红，却全绿——判据失去判别力');
    assert.ok(
      problems.some((problem) => problem.includes('no-such-job')),
      `红的原因不对：${problems.join('；')}`,
    );
  });
});
