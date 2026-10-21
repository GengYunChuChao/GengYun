/**
 * CI 门禁：`.github/workflows/deploy-sql-gate.yml` 必须保留**误授恢复演练**那一步。
 *
 * 为什么需要它（实证出处见 `docs/verification/gy-r28-deploy-sql-recovery-replay-20261021.md`）：
 *  1. `deploy/postgres-cvm/sql/20-login-roles.sql` 的 I 段按列授予 `public.favorites` 的
 *     SELECT/INSERT/UPDATE，而 PG 的列级 ACL 落在 `pg_attribute.attacl`。本仓已实测过：
 *     **表级 `REVOKE <priv> ON <table>` 会连带撤销同类型的列级授权**（S38 证据页写死）。
 *     ⇒ 误授之后唯一正解是**重跑 `20-login-roles.sql`**，不是再补一条 GRANT。
 *  2. 但该 workflow 在 R28-S42 之前**只跑一次** 20-login-roles.sql ⇒ 这条救命恢复路径从未被
 *     任何 CI 跑过。把 I 段改成「角色不存在才 GRANT」、或给 GRANT 加条件，CI 照样全绿。
 *  3. 既有测试全都测不到它：`tests/unit/ci-real-pg-wiring.test.mjs` 只看 workflow 是否真连 PG、
 *     `ci-contract-status-gate.test.mjs` 只看另一个 job 的校验器入口。删掉恢复演练那一步，
 *     全仓测试仍然全绿 —— 这正是本文件要补的缺口。
 *
 * 本文件是**纯静态**检查：只 `fs.readFileSync` 读 workflow 与两个 SQL 文件。
 * ⛔ 不引入 `yaml` 依赖（按缩进逐行解析）、不联网、不 `spawn` 子进程、不写任何文件、
 * ⛔ 不 import 兄弟测试文件（import 会把那边的 `test(...)` 一起注册进本进程）。
 *
 * 钉住的七条（①–⑥ 与派单 §2.3 逐条对应）：
 *  1) 该 job 里**存在**名字逐字为「恢复演练：撤销一列授权 → 重跑 20-login-roles.sql →
 *     90-assert 仍 ok」的 step；
 *  2) 它排在「90-assert-least-privilege.sql（末行 ok 且退出码 0）」之后，且是**最后一步**；
 *  3) run 内顺序固定：前置 `t` 自检 → 循环跑 2 次 roles → `REVOKE SELECT (id)` →
 *     撤销后 `f` → 再跑 roles → 恢复后 `t` → 复跑 90-assert 且末行必须正好 `ok`；
 *  4) 该 step 不带 `if:` / `continue-on-error` / `|| true` / `set +e`（否则演练变装饰品）；
 *  5) 全 workflow 没有 `continue-on-error: true`，任何 step 的 psql 命令都不接 `|| true`；
 *  6) 不再出现「78 条断言」这类写死的断言条数（S38 后已是 83，硬编码必然过期）；
 *  7) 每条失败分支都有可读的 `::error::` + `exit 1`（数量必须一致），且该 step 的 `env`
 *     带 `GENGYUN_API_RUNTIME_PASSWORD`（重跑 roles 少了它必然失败）。
 *
 * 刻意不做（不冒充能力）：本文件只做**文本/结构**判定，**不**证明演练在真实 PG 上跑得过；
 * 真实读数由证据页 `docs/verification/gy-r28-deploy-sql-recovery-replay-20261021.md` §3–§5 承担。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（tests/unit/ → ../..），⛔ 不用 `process.cwd()`。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_FILE = '.github/workflows/deploy-sql-gate.yml';
const JOB_ID = 'deploy-sql-17-11';
/** 必须原样存在的 step 名（与 workflow 里逐字一致；改名必须同步改本行）。 */
const DRILL_STEP_NAME = '恢复演练：撤销一列授权 → 重跑 20-login-roles.sql → 90-assert 仍 ok';
/** 演练必须排在这步之后的那一步（双保险断言步）。 */
const ANCHOR_STEP_NAME = '90-assert-least-privilege.sql（末行 ok 且退出码 0）';
const ROLES_SQL = 'deploy/postgres-cvm/sql/20-login-roles.sql';
const ASSERT_SQL = 'deploy/postgres-cvm/sql/90-assert-least-privilege.sql';
/** 演练里唯一的写操作；表级/列级授权形态必须是「列级 SELECT on favorites(id)」。 */
const REVOKE_SQL = 'REVOKE SELECT (id) ON TABLE public.favorites FROM gengyun_api_runtime';
/** 前置授权为 `t` 的探针（与 workflow 里逐字一致，含四个实参）。 */
const COL_PRIV_SQL = "has_column_privilege('gengyun_api_runtime', 'public.favorites', 'id', 'SELECT')";
/** 会吞掉非零退出的写法（step 级与命令级都要挡）。 */
const SOFT_FAILURE_PATTERNS = Object.freeze([
  ['`|| true`', /\|\|\s*true\b/],
  ['`set +e`', /(?:^|[\s;&|])set\s+\+e\b/],
]);

/** 读仓库内文本文件；不存在就给可操作的失败信息（而不是 readFileSync 的 ENOENT 堆栈）。 */
function readRepoText(relativePath) {
  const absolute = join(REPO_ROOT, relativePath);
  assert.ok(existsSync(absolute), `仓库里找不到 ${relativePath}（仓库根解析为 ${REPO_ROOT}）`);
  return readFileSync(absolute, 'utf8');
}

/** 按 YAML 缩进切出 `jobs.<jobId>` 这一块，返回半开行区间（0 基）。 */
function jobBlockOf(source, jobId = JOB_ID) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line === `  ${jobId}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[^\s#][^:]*:\s*$/.test(lines[index]) || /^[^\s]/.test(lines[index])) { end = index; break; }
  }
  return { lines, start, end };
}

/** 该 job 的 job 名（`assert` 失败时给可操作提示用）。 */
function jobOf() {
  const job = jobBlockOf(readRepoText(WORKFLOW_FILE));
  assert.ok(job, `\`${WORKFLOW_FILE}\` 里找不到 \`${JOB_ID}:\` 这个 job（2 空格缩进）；`
    + '若 job 被改名或嵌套层级变了，本门禁必须同步改 JOB_ID，⛔ 不许直接删掉这条守卫。');
  return job;
}

/**
 * 切出该 job 的 steps：按「`- ` 的最小缩进」判定 step 边界，返回每步的起始行号（1 基）。
 * 只认 `<indent>- name|uses|run:`（本仓 workflow 的 step 一律这么写）。
 */
function stepsOf(job) {
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
    return { line: stepStart + 1, lines: lines.slice(stepStart, stepEnd) };
  });
}

/** 一个 step 的 `name:` 值（内联写法）；没有 `name:` 时返回空串。 */
function stepNameOf(step) {
  const hit = step.lines.find(line => /^\s*-\s+name\s*:/.test(line) || /^\s*name\s*:/.test(line));
  if (!hit) return '';
  return hit.replace(/^\s*(?:-\s+)?name\s*:\s*/, '').trim();
}

/** 缩进宽度（制表符按 1 计；本仓 workflow 只用空格）。 */
function indentOf(line) {
  return /^ */.exec(line)[0].length;
}

/**
 * 取出 step 里 `run:` 块的**命令正文**（含块内注释行）。
 * 只读 `run:` 字段，不碰 `name:` / `env:` —— 否则说明文字里的示例会被当成命令。
 */
function runBodyOf(step) {
  const runAt = step.lines.findIndex(line => /^\s*(?:-\s+)?run\s*:/.test(line));
  assert.ok(runAt !== -1, `第 ${step.line} 行起的 step 没有 \`run:\`：本门禁只认 shell 步骤。`);
  const keyIndent = indentOf(step.lines[runAt]);
  const body = [];
  for (let index = runAt + 1; index < step.lines.length; index += 1) {
    const line = step.lines[index];
    if (line.trim() !== '' && indentOf(line) <= keyIndent) break;
    body.push(line);
  }
  return body.join('\n');
}

/** 找一个 step：优先按名字逐字匹配；找不到就返回 null。 */
function stepByName(steps, name) {
  return steps.find(step => stepNameOf(step) === name) ?? null;
}

/** 取演练那一步，缺失时给「照抄哪一段」的可操作提示。 */
function drillStep() {
  const steps = stepsOf(jobOf());
  const drill = stepByName(steps, DRILL_STEP_NAME);
  if (drill) return { steps, drill };
  const existing = steps.map(step => `第 ${step.line} 行：${stepNameOf(step) || '(无 name)'}`).join('\n');
  assert.fail([
    `\`${WORKFLOW_FILE}\` 的 \`${JOB_ID}\` job 里没有「${DRILL_STEP_NAME}」这一步：`,
    '⇒ 误授之后「重跑 20-login-roles.sql 把列级授权恢复回来」这条路径不在 CI 上跑。',
    '把 20-login-roles.sql 的 I 段改成条件授权（例如「角色不存在才 GRANT」）后，演练缺席时 CI 仍全绿。',
    `改法：在同 job 的 \`${ANCHOR_STEP_NAME}\` 之后追加这一步（名字逐字照抄，本门禁按名字定位），`,
    '并保留 run 内的五段顺序：前置 t 自检 → 循环 2 次 roles → REVOKE 该列 → 恢复 roles → 复跑 90-assert。',
    '⛔ 不要加 `if:`、`continue-on-error`、`|| true`，也不要把它挪到断言步之前。',
    `该 job 现有 step：\n${existing}`,
  ].join('\n'));
  return null;
}

/** 所有出现位置（用于顺序判定；同一文件被引用多次是正常的）。 */
function indexOfAll(haystack, needle) {
  const hits = [];
  let cursor = haystack.indexOf(needle);
  while (cursor !== -1) {
    hits.push(cursor);
    cursor = haystack.indexOf(needle, cursor + needle.length);
  }
  return hits;
}

test('① 恢复演练那一步存在，且名字逐字一致', () => {
  const { drill } = drillStep();
  assert.equal(stepNameOf(drill), DRILL_STEP_NAME);
  const body = runBodyOf(drill);
  assert.ok(body.includes('psql'), `第 ${drill.line} 行的恢复演练里没有任何 \`psql\` 调用：它必须真的对库读写授权，`
    + '⛔ 不能只是一段 echo/注释（那样的演练永远是绿的）。');
});

test('② 它排在「末行 ok 且退出码 0」那一步之后，且是最后一步', () => {
  const { steps, drill } = drillStep();
  const anchor = stepByName(steps, ANCHOR_STEP_NAME);
  assert.ok(anchor, [
    `\`${JOB_ID}\` job 里找不到「${ANCHOR_STEP_NAME}」这一步。`,
    '它是恢复演练的锚点：演练必须在「90-assert 双保险」之后跑（先证明现状合规，再证明被撤后能恢复）。',
    '若那一步被改名/删除，先把它修回，再谈本门禁 —— ⛔ 不许把锚点改成本门禁去迁就 workflow。',
    `该 job 现有 step：${steps.map(step => stepNameOf(step) || '(无 name)').join(' / ')}`,
  ].join('\n'));
  assert.ok(drill.line > anchor.line, [
    `恢复演练在第 ${drill.line} 行，却排在「${ANCHOR_STEP_NAME}」（第 ${anchor.line} 行）之前。`,
    '顺序反了会让演练在「库还没被断言成合规态」时就 REVOKE 一列，之后的断言步会把误授态当成基线。',
    '改法：把整步挪到断言步之后（⛔ 不要反过来挪断言步）。',
  ].join('\n'));
  assert.equal(drill.line, steps[steps.length - 1].line, [
    `恢复演练不是最后一步（它在第 ${drill.line} 行，最后一步是第 ${steps[steps.length - 1].line} 行）。`,
    '演练的最后一段是「复跑 90-assert 并要求末行 ok」——它必须是这个 job 的收尾判决；',
    '若在它之后还有步骤，那些步骤会在「库被临时 REVOKE 又被恢复」的状态之后跑，读数含义就变了。',
    '改法：把新步骤放到恢复演练之前；确需追加在之后时，必须同步说明理由并改本断言。',
  ].join('\n'));
});

test('③ run 内顺序固定：前置 t → 2 次 roles → REVOKE → f → roles → t → 90-assert 且末行 ok', () => {
  const { drill } = drillStep();
  const body = runBodyOf(drill);

  // 前置授权探针：SQL 只写一次（放在 `col_priv()` 里，避免三份写法漂移），但必须被调用 3 次：
  // 前置自检 / 撤销后 / 恢复后。少一次就意味着有一段读数没被验，演练会静默变绿。
  const probes = indexOfAll(body, COL_PRIV_SQL);
  assert.equal(probes.length, 1, `恢复演练里 \`${COL_PRIV_SQL}\` 出现了 ${probes.length} 次（要求 1 次：`
    + '只放在 `col_priv()` 里当唯一出处）。写多份会让三处读数用不同的 SQL，'
    + '⛔ 也就无法保证「撤销前 / 撤销后 / 恢复后」量的是同一个权限。');
  const reads = indexOfAll(body, '$(col_priv)');
  assert.equal(reads.length, 3, `恢复演练里只读了 ${reads.length} 次 \`col_priv\`（要求 3 次：`
    + '前置自检、撤销后、恢复后）。少一次就意味着有一段读数没被验，演练会静默变绿。');

  // 两次重跑必须靠「循环 2 次」实现，不能靠手写两遍（手写两遍时改一处容易漏另一处）。
  assert.match(body, /for\s+attempt\s+in\s+1\s+2\s*;?\s*do/, [
    '恢复演练里没有 `for attempt in 1 2; do` 循环。',
    '「连跑两次 roles 证明幂等」必须由循环表达：两次的退出码各打印一次、各判一次；',
    '⛔ 不要手写两遍（改一处漏一处时，第二次的读数会假绿）。',
  ].join('\n'));

  const revokeAt = body.indexOf(REVOKE_SQL);
  assert.ok(revokeAt !== -1, `恢复演练里找不到那条 REVOKE：\`${REVOKE_SQL}\``);
  const rolesRuns = indexOfAll(body, ROLES_SQL);
  const assertRuns = indexOfAll(body, ASSERT_SQL);
  assert.equal(rolesRuns.length, 2, `恢复演练里 \`${ROLES_SQL}\` 出现了 ${rolesRuns.length} 次（要求 2 次：`
    + '循环里 1 次＋恢复时 1 次）。第 1 次在 REVOKE 之前（幂等重跑），第 2 次在 REVOKE 之后（恢复）。');
  assert.equal(assertRuns.length, 1, `恢复演练里 \`${ASSERT_SQL}\` 出现了 ${assertRuns.length} 次（要求 1 次：`
    + '恢复后复验）。⛔ 漏掉它就没有「恢复后仍然合规」的判决。');

  assert.ok(reads[0] < rolesRuns[0], [
    `第 1 次读 \`col_priv\`（字符位 ${reads[0]}）不在第 1 次 roles（字符位 ${rolesRuns[0]}）之前。`,
    '顺序是「先自检该列已授、再证明 roles 幂等」：前置不成立时应当立刻红，',
    '而不是先跑两遍 roles 把缺失的授权补上、再自检成 t（那样前置自检就永远为真）。',
  ].join('\n'));
  assert.ok(rolesRuns[0] < revokeAt, [
    `第 1 次 \`${ROLES_SQL}\`（字符位 ${rolesRuns[0]}）不在 REVOKE（字符位 ${revokeAt}）之前。`,
    '顺序必须是「先证明脚本本身幂等（连跑两次 exit 0），再制造误授」；',
    '反过来的话，撤销后的重跑会同时承担「恢复」和「幂等」两种语义，读数无法归因。',
  ].join('\n'));
  assert.ok(revokeAt < rolesRuns[1], `REVOKE（字符位 ${revokeAt}）必须在第 2 次 roles（字符位 ${rolesRuns[1]}）之前：`
    + '否则「恢复」是在没有误授态的情况下跑的，什么也没证明。');
  assert.ok(rolesRuns[1] < assertRuns[0], `恢复用的 roles（字符位 ${rolesRuns[1]}）必须在复验 90-assert`
    + `（字符位 ${assertRuns[0]}）之前：先恢复、后断言。`);

  // 三段读数各自必须与期望值比较（只打印不比较 = 演练不判红）。
  const expectationPairs = [
    ['${before}', 't', '前置自检要求 `t`（该列原本已授）'],
    ['${revoked}', 'f', '撤销后要求 `f`（确实撤掉了）'],
    ['${recovered}', 't', '恢复后要求 `t`（重跑 roles 把授权带回来了）'],
  ];
  for (const [variable, expected, meaning] of expectationPairs) {
    const pattern = new RegExp(`"\\${variable}"\\s*!=\\s*"${expected}"`);
    assert.match(body, pattern, `恢复演练里没有把 ${variable} 与 "${expected}" 比较：${meaning}。`
      + '只 echo 读数不比较，读数错了也不会判红。');
  }
  assert.match(body, /"\$\{verdict\}"\s*!=\s*"ok"/, '恢复演练末尾没有把末行判决与 `ok` 逐字比较：'
    + '90-assert 的判决行若变成 `FAIL: …`，只判退出码会漏（R28-S33 之前退出码恒 0）。');
  assert.match(body, /awk\s+'NF \{ last = \$0 \} END \{ print last \}'/, '恢复演练取末行的方式必须与断言步同口径'
    + '（`awk \'NF { last = $0 } END { print last }\'`）：换一种取法会让「末行」与「末个非空行」判得不一样。');
});

test('④ 那一步不带任何软失败构造（`if:` / `continue-on-error` / `|| true` / `set +e`）', () => {
  const { drill } = drillStep();
  const body = runBodyOf(drill);
  const hits = [];
  drill.lines.forEach((line, offset) => {
    if (/^\s*(?:-\s+)?if\s*:/.test(line)) hits.push(`第 ${drill.line + offset} 行（YAML）有 \`if:\`：${line.trim()}`);
    if (/^\s*(?:-\s+)?continue-on-error\s*:/.test(line)) {
      hits.push(`第 ${drill.line + offset} 行（YAML）有 \`continue-on-error:\`：${line.trim()}`);
    }
  });
  for (const [label, pattern] of SOFT_FAILURE_PATTERNS) {
    if (pattern.test(body)) hits.push(`run 正文里出现 ${label}：非零退出会被吞掉，演练等于没跑`);
  }
  assert.deepEqual(hits, [], [
    `恢复演练被改成了软失败（${hits.length} 处）：`,
    ...hits.map(hit => `  · ${hit}`),
    '以上任一构造都会让「恢复失败」仍被判绿 —— 演练就从门禁退化成装饰品。',
    '改法：那一步只留 `set -euo pipefail` 与显式的 `if [ … ]; then … exit 1; fi`；',
    '命令失败用 `|| rc=$?` 接住并**显式判 rc**（⛔ 不是 `|| true`）。',
  ].join('\n'));
});

test('⑤ 全 workflow 无 `continue-on-error: true`，且任何 step 的 psql 命令都不接 `|| true`', () => {
  const source = readRepoText(WORKFLOW_FILE);
  const hits = [];
  source.split('\n').forEach((line, offset) => {
    if (/continue-on-error\s*:\s*(?:true|yes|on)\b/i.test(line)) {
      hits.push(`第 ${offset + 1} 行有 \`continue-on-error\` 真值：${line.trim()}`);
    }
  });
  assert.deepEqual(hits, [], [
    `\`${WORKFLOW_FILE}\` 里出现了会把失败判成绿的 \`continue-on-error\`（${hits.length} 处）：`,
    ...hits.map(hit => `  · ${hit}`),
    '这个 workflow 的全部判据都是退出码＋末行，任何一步被允许失败，整条链路就只剩「看起来跑过」。',
    '改法：删掉该字段；确实需要「失败但继续」的读数，请在 shell 里显式接住退出码并自己判（不是让 CI 忽略它）。',
  ].join('\n'));

  const softHits = [];
  for (const step of stepsOf(jobOf())) {
    // 只扫 shell 步骤：`uses:` 型 step 没有 run 正文，跳过（它也不会执行 psql）。
    if (!step.lines.some(line => /^\s*(?:-\s+)?run\s*:/.test(line))) continue;
    const body = runBodyOf(step);
    const name = stepNameOf(step) || '(无 name)';
    for (const line of body.split('\n')) {
      if (!/psql\b/.test(line)) continue;
      if (/\|\|\s*true\b/.test(line)) softHits.push(`第 ${step.line} 行起的「${name}」：${line.trim()}`);
    }
  }
  assert.deepEqual(softHits, [], [
    `有 ${softHits.length} 条 psql 命令接了 \`|| true\`：`,
    ...softHits.map(hit => `  · ${hit}`),
    'psql 的退出码是本 workflow 唯一的机器判据（末行文本只是可读兜底）；`|| true` 会把它抹掉。',
    '改法：要读退出码就写 `rc=0; psql … || rc=$?;` 然后显式判 rc。',
  ].join('\n'));
});

test('⑥ 不再出现「78 条断言」这类写死的断言条数', () => {
  const source = readRepoText(WORKFLOW_FILE);
  const hits = [];
  source.split('\n').forEach((line, offset) => {
    if (line.includes('78 条断言')) hits.push(`第 ${offset + 1} 行：${line.trim()}`);
  });
  assert.deepEqual(hits, [], [
    `\`${WORKFLOW_FILE}\` 里仍有写死的「78 条断言」（${hits.length} 处）：`,
    ...hits.map(hit => `  · ${hit}`),
    '90-assert 的断言条数随切片增长（S28 的 78 → S38 的 83），写死的数字必然过期；',
    '更坏的是它把「条数对不对」误当成判据 —— 条数变了但全绿是**正常**的。',
    '改法：删掉数字，只留「退出码 0 且末行 ok」；⛔ 也不要换成另一个硬编码数字。',
  ].join('\n'));
});

test('⑦ 每条失败分支都有可读的 `::error::` + `exit 1`，且 env 带运行时口令', () => {
  const { drill } = drillStep();
  const body = runBodyOf(drill);
  const errors = (body.match(/echo "::error::/g) ?? []).length;
  const exits = (body.match(/^\s*exit 1\s*$/gm) ?? []).length;
  assert.ok(errors >= 6, `恢复演练里只有 ${errors} 处 \`echo "::error::\`（至少 6 处：前置不成立、两次重跑各一次、`
    + 'REVOKE 失败、撤销后读数不是 f、恢复失败、恢复后读数不是 t、复验退出码、末行不是 ok）。'
    + '缺可读信息的失败等于「CI 红了但不知道为什么」，会被人直接放宽判据。');
  assert.equal(errors, exits, `\`echo "::error::\`（${errors} 处）与 \`exit 1\`（${exits} 处）数量不等：`
    + '有分支打印了原因却没有失败，或有分支静默退出；两种都会让演练的判红路径不可靠。');
  assert.ok(drill.lines.some(line => /^\s*GENGYUN_API_RUNTIME_PASSWORD\s*:/.test(line)), [
    `恢复演练的 env 里没有 \`GENGYUN_API_RUNTIME_PASSWORD\`。`,
    '重跑 20-login-roles.sql 时它的 \\getenv 守卫会因「环境变量未设置」直接失败（拒绝创建无口令 LOGIN），',
    '演练会红在一个与恢复路径无关的地方，掩盖真正要证明的事。',
    '改法：照第 ③ 步（20-login-roles.sql）的 env 补这一行（同一个 48 位合成值，不是新口令）。',
  ].join('\n'));
});

test('⑧ 演练引用的两个 SQL 文件真实存在且非空', () => {
  for (const relativePath of [ROLES_SQL, ASSERT_SQL]) {
    const absolute = join(REPO_ROOT, relativePath);
    assert.ok(existsSync(absolute), [
      `恢复演练引用的是 \`${relativePath}\`，但仓库里没有这个文件（仓库根解析为 ${REPO_ROOT}）。`,
      '这正是「钉了一个不存在的路径」：workflow 看起来有演练，实际每次 CI 都会因找不到 SQL 而红，',
      '然后最可能发生的「修法」是把演练删掉。',
      '改法：把路径写回仓库里真实存在的那份（⛔ 不改名、不指向 .bak / 临时脚本）。',
    ].join('\n'));
    assert.ok(statSync(absolute).isFile(), `\`${relativePath}\` 不是常规文件（目录/符号链接/设备）`);
    assert.ok(statSync(absolute).size > 0, `\`${relativePath}\` 是空文件：空 SQL 什么也证明不了`);
  }
});
