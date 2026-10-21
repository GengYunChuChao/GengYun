/**
 * CI 门禁：`.github/workflows/deploy-sql-gate.yml` 的 job `deploy-sql-17-11` 必须**真跑**
 * 运行期授权面探针 `deploy/postgres-cvm/evidence/probe-runtime-grants.sql`，并且带结构化判据。
 *
 * 为什么需要它（实证出处见 `docs/verification/gy-r28-probe-in-ci-20261021.md`）：
 *  1. 该探针是本仓「运行期角色到底能碰哪些表/列/函数」的主证据件（694 行，8 段），
 *     但在 R28-S71 之前 **没有任何 workflow 或测试执行它** —— `git grep -ln probe-runtime-grants`
 *     在 `.github/workflows` 与 `tests` 下零命中。⇒ 探针可以任意烂掉而 CI 全绿。
 *  2. 它自带 `\set ON_ERROR_STOP 0`（设计如此：要一次性收齐全部 42501 读数），
 *     **psql 的退出码恒为 0**。⇒ 「跑过」不等于「验过」：必须对输出做判据，否则加一步只等于加噪音。
 *  3. 判据必须双向：授多了（禁止面不再 42501）与授少了（正向语句被误拒权）都要红；
 *     只数标记条数会漏掉「多授权」，只数 42501 会漏掉「整段没跑到」（段没跑到时标记与计数一起消失，
 *     而计数判据是「恰好等于期望值」⇒ 少报同样红）。
 *
 * 本文件是**纯静态**检查：只 `fs.readFileSync` 读 workflow、探针 SQL、证据页是否在。
 * ⛔ 不引入 `yaml` 依赖（按缩进逐行解析）、不联网、不 `spawn` 子进程、不写任何文件、
 * ⛔ 不 import 兄弟测试文件（import 会把那边的 `test(...)` 一起注册进本进程）。
 * ⛔ 也不伪装成「跑过真实 PG」：真实读数（绿/NC1 红/复原绿）由证据页 §3–§5 承担。
 *
 * 钉住的六条：
 *  1) 该 job 里**存在**名字逐字为「授权面探针 probe-runtime-grants.sql（退出码 0 + 标记 + 错误条数）」
 *     的 step，且它真的用 `psql` 跑那份探针文件；
 *  2) 它排在「90-assert-least-privilege.sql（末行 ok 且退出码 0）」之后、**恢复演练之前**
 *     （恢复演练必须仍是最后一步：`tests/unit/deploy-sql-gate-recovery.test.mjs` 的测试② 钉着）；
 *  3) 该 step 不带 `if:` / `continue-on-error` / `|| true` / `set +e`，全 workflow 无 `continue-on-error`；
 *  4) 标记清单非空，且**每条都能在探针源码里找到出处**：`###`/`-- [` 段落行逐字出现；
 *     `permission denied for <表|schema|函数> X` 的 X 必须在探针源码里被点到 ⇒ 改坏一个字就红；
 *  5) 禁止面对象集合恰好是那 9 个（5 表 + 2 schema + 2 函数），一条都不能少；
 *  6) `expected_42501` 必须等于**从探针源码数出来的**禁止面条数（段 6/7 的 6 条 ＋ 段 8b/8c 的 5 条
 *     ＋ 段 9b 的 3 条 ＋ 段 10 的 2 条 ＋ 段 11 的 2 条 = 18）⇒ 探针增删禁止面而 workflow 没跟，红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（tests/unit/ → ../..），⛔ 不用 `process.cwd()`。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_FILE = '.github/workflows/deploy-sql-gate.yml';
const JOB_ID = 'deploy-sql-17-11';
/** 必须原样存在的 step 名（与 workflow 里逐字一致；改名必须同步改本行）。 */
const PROBE_STEP_NAME = '授权面探针 probe-runtime-grants.sql（退出码 0 + 标记 + 错误条数）';
/** 探针必须排在这步之后的那一步（双保险断言步）。 */
const ANCHOR_STEP_NAME = '90-assert-least-privilege.sql（末行 ok 且退出码 0）';
/** 探针必须排在这步之前的那一步（恢复演练是 job 的收尾判决）。 */
const DRILL_STEP_NAME = '恢复演练：撤销一列授权 → 重跑 20-login-roles.sql → 90-assert 仍 ok';
const PROBE_SQL = 'deploy/postgres-cvm/evidence/probe-runtime-grants.sql';
const EVIDENCE_PAGE = 'docs/verification/gy-r28-probe-in-ci-20261021.md';
/** 禁止面必须被拒权的 9 个对象：5 张表 / 2 个 schema / 2 个函数。 */
const DENY_OBJECTS = Object.freeze([
  'recognition_jobs',
  'recognition_records',
  'recognition_selections',
  'speech_jobs',
  'transcriptions',
  'catalog_ops',
  'staging_intake',
  'consent_policy_immutable',
  'admin_audit_events_reject_mutation',
]);
/** 段 6/7 的「四表 DELETE + selections 的 FOR UPDATE」必须全部 42501。 */
const DENY_DELETE_TABLES = Object.freeze([
  'recognition_jobs',
  'recognition_records',
  'recognition_selections',
  'speech_jobs',
  'transcriptions',
]);
/** 段 8b/8c 的 5 条固定语句（3 条 internal 函数 + 2 条 trigger 函数），逐字来自探针源码。 */
const DENY_FIXED_STATEMENTS = Object.freeze([
  /SELECT id FROM public\.recognition_selections WHERE false FOR UPDATE;/,
  /SELECT catalog_ops\.apply_source_operation\(/,
  /SELECT staging_intake\.apply_import\(/,
  /SELECT staging_intake\.rollback_import\(/,
  /SELECT public\.consent_policy_immutable\(\);/,
  /SELECT public\.admin_audit_events_reject_mutation\(\);/,
]);
/**
 * 段 9b/10/11 的 7 条固定语句（视图/跨 schema/导出表写/GRANT/CREATE），逐字来自探针源码。
 * 全部按**整行锚定**（`^…$` + 多行）：探针的 `\echo` 说明文字里也常提到同一条语句，
 * 只按子串数会多数出来（`INSERT INTO staging_intake.batches` 就同时出现在 :774 与 :770 的 \echo 里）。
 */
const DENY_LATE_STATEMENTS = Object.freeze([
  /^SELECT \* FROM catalog_read\.registration_evidence LIMIT 0;$/,
  /^SELECT \* FROM catalog_ops\.operations LIMIT 0;$/,
  /^INSERT INTO staging_intake\.batches$/,
  /^SELECT revision, cancelled_at FROM public\.exports WHERE false;$/,
  /^UPDATE public\.exports SET revision = revision WHERE false;$/,
  /^GRANT gengyun_preview_reader TO gengyun_api_runtime;$/,
  /^CREATE TABLE public\.r28_s58_probe \(id integer\);$/,
]);
/** 会吞掉非零退出的写法（step 级与命令级都要挡）。 */
const SOFT_FAILURE_PATTERNS = Object.freeze([
  ['`|| true`', /\|\|\s*true\b/],
  ['`set +e`', /(?:^|[\s;&|])set\s+\+e\b/],
  ['`continue-on-error`', /continue-on-error\s*:/],
  ['`if:`（含 always()/success() 之类条件）', /^\s*(?:-\s+)?if\s*:/],
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

/** 该 job 的 job 块（`assert` 失败时给可操作提示用）。 */
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

/** 取出 step 里 `run:` 块的**命令正文**（含块内注释行）；只读 `run:`，不碰 `name:` / `env:`。 */
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

/** 取探针那一步，缺失时给「照抄哪一段」的可操作提示。 */
function probeStep() {
  const steps = stepsOf(jobOf());
  const probe = stepByName(steps, PROBE_STEP_NAME);
  if (probe) return { steps, probe };
  const existing = steps.map(step => `第 ${step.line} 行：${stepNameOf(step) || '(无 name)'}`).join('\n');
  assert.fail([
    `\`${WORKFLOW_FILE}\` 的 \`${JOB_ID}\` job 里没有「${PROBE_STEP_NAME}」这一步：`,
    `⇒ 运行期授权面探针 \`${PROBE_SQL}\` 又回到了「没有任何 CI 跑它」的状态。`,
    '把 20-login-roles.sql 的列级/函数级授权改错，只要 90-assert 仍 ok，CI 就会全绿。',
    `改法：在同 job 的 \`${ANCHOR_STEP_NAME}\` 之后、\`${DRILL_STEP_NAME}\` 之前插入这一步`
      + '（名字逐字照抄，本门禁按名字定位）。',
    '判据必须三件套：psql 退出码 0 ＋ 关键标记逐条 grep ＋ 禁止面 42501 条数恰好等于期望值。',
    '⛔ 不要加 `if:`、`continue-on-error`、`|| true`；⛔ 不要把它挪到最后一步（会踩恢复演练的顺序守卫）。',
    `该 job 现有 step：\n${existing}`,
  ].join('\n'));
  return null;
}

/** 探针源码（去掉行尾 CR，便于逐字比对标记）。 */
function probeSource() {
  return readRepoText(PROBE_SQL).replace(/\r\n/g, '\n');
}

/** 从 step 的 run 正文里抽出 `markers=( … )` 清单（保留顺序）。 */
function markersOf(body) {
  const lines = body.split('\n');
  const startAt = lines.findIndex(line => line.trim() === 'markers=(');
  assert.notEqual(startAt, -1, [
    '探针那一步里没有 `markers=(` 清单：判据只能是「grep 一批关键标记」，',
    '清单缺席意味着标记要么没定义、要么散在若干条手写 grep 里（改一处漏一处）。',
  ].join('\n'));
  const endAt = lines.findIndex((line, index) => index > startAt && line.trim() === ')');
  assert.notEqual(endAt, -1, `\`markers=(\` 之后找不到闭合的 \`)\`（从第 ${startAt + 1} 行起算）。`);
  const entries = lines.slice(startAt + 1, endAt);
  return entries.map(line => {
    const match = /^\s*'([^']+)',?\s*$/.exec(line);
    assert.ok(match, `markers 清单里有不符合 \`'<标记>'\` 形状的行：${JSON.stringify(line.trim())}`
      + '（bash 数组只认单引号元素；写成裸字符串会被拆词）。');
    return match[1];
  });
}

/** 所有出现位置（用于计数/顺序判定）。 */
function indexOfAll(haystack, needle) {
  const hits = [];
  let cursor = haystack.indexOf(needle);
  while (cursor !== -1) {
    hits.push(cursor);
    cursor = haystack.indexOf(needle, cursor + needle.length);
  }
  return hits;
}

/**
 * 从探针源码数出「应当被拒权（42501）」的语句条数：
 * 段 6/7 的 6 条（5 表 DELETE + selections 的 FOR UPDATE）＋ 段 8b/8c 的 5 条函数
 * ＋ 段 9b 的 3 条（视图/schema 跨域）＋ 段 10 的 2 条（exports 读与写）＋ 段 11 的 2 条（GRANT/CREATE）。
 * 合计 18：这是真 CI 上一次一步红时的读数，也是 workflow 里 `expected_42501` 的唯一来源。
 */
function countDenyStatements(source) {
  const text = source.replace(/\r\n/g, '\n');
  let total = 0;
  for (const table of DENY_DELETE_TABLES) {
    const pattern = new RegExp(`DELETE FROM public\\.${table} WHERE false RETURNING id;`, 'g');
    const hits = text.match(pattern) ?? [];
    assert.equal(hits.length, 1, `探针源码里 \`DELETE FROM public.${table} … RETURNING id;\` 出现 ${hits.length} 次`
      + '（要求恰好 1 次：段 6/7 的禁止面各一条，多写或漏写都会让「错误条数」判据算错）。');
    total += hits.length;
  }
  for (const pattern of DENY_FIXED_STATEMENTS) {
    const hits = text.match(new RegExp(pattern.source, 'g')) ?? [];
    assert.equal(hits.length, 1, `探针源码里 \`${pattern.source}\` 出现 ${hits.length} 次`
      + '（要求恰好 1 次：禁止面语句既是「必须 42501」的证据，也是错误条数算式的加数）。');
    total += hits.length;
  }
  for (const pattern of DENY_LATE_STATEMENTS) {
    const hits = text.match(new RegExp(pattern.source, 'gm')) ?? [];
    assert.equal(hits.length, 1, `探针源码里 \`${pattern.source}\` 出现 ${hits.length} 次`
      + '（要求恰好 1 次：段 9b/10/11 的禁止面同样各产出一行 42501，漏算会让期望值偏小、判据恒红）。');
    total += hits.length;
  }
  return total;
}

test('① 探针那一步存在，且真的用 psql 跑那份探针 SQL', () => {
  const { probe } = probeStep();
  assert.equal(stepNameOf(probe), PROBE_STEP_NAME);
  const body = runBodyOf(probe);
  assert.ok(body.includes(PROBE_SQL), `第 ${probe.line} 行的探针 step 里没有引用 \`${PROBE_SQL}\`：`
    + '那它跑的一定不是这份证据件（改名/换路径后本门禁必须同步改 PROBE_SQL）。');
  assert.match(body, /psql\b[^\n]*-f\s+"\$\{probe\}"/, [
    `第 ${probe.line} 行的探针 step 里没有 \`psql … -f "\${probe}"\`：`,
    '探针必须真的连库执行（⛔ 不能只 echo 一段说明，那样的 step 永远是绿的）。',
  ].join('\n'));
  assert.match(body, /ON_ERROR_STOP=0/, '探针步必须显式带 `-v ON_ERROR_STOP=0`：文件头已经把 ON_ERROR_STOP '
    + '设成 0（设计如此），命令行再写一次是为了让「不中止」这件事在 workflow 里可见、不被误当成吞错。');
});

test('② 它排在 90-assert 之后、恢复演练之前（恢复演练仍是最后一步）', () => {
  const { steps, probe } = probeStep();
  const anchor = stepByName(steps, ANCHOR_STEP_NAME);
  assert.ok(anchor, [
    `\`${JOB_ID}\` job 里找不到「${ANCHOR_STEP_NAME}」这一步。`,
    '它是探针步的锚点：授权面探针必须在「90-assert 双保险」之后跑（先证明静态断言口径合规，再打真实读写）。',
    '若那一步被改名/删除，先把它修回，再谈本门禁 —— ⛔ 不许把锚点改成本门禁去迁就 workflow。',
    `该 job 现有 step：${steps.map(step => stepNameOf(step) || '(无 name)').join(' / ')}`,
  ].join('\n'));
  assert.ok(probe.line > anchor.line, [
    `探针步在第 ${probe.line} 行，却排在「${ANCHOR_STEP_NAME}」（第 ${anchor.line} 行）之前。`,
    '顺序反了会让探针在「库还没被断言成合规态」时先跑，读数失去基线。',
    '改法：把整步挪到断言步之后（⛔ 不要反过来挪断言步）。',
  ].join('\n'));

  const drill = stepByName(steps, DRILL_STEP_NAME);
  assert.ok(drill, [
    `\`${JOB_ID}\` job 里找不到「${DRILL_STEP_NAME}」这一步。`,
    '恢复演练是本 job 的收尾判决（撤销一列授权 → 重跑 roles → 复跑 90-assert 仍 ok）；',
    '探针步只能插在它与断言步之间。若演练被删/改名，先修回演练（它的守卫在 deploy-sql-gate-recovery.test.mjs）。',
  ].join('\n'));
  assert.ok(probe.line < drill.line, [
    `探针步在第 ${probe.line} 行，却排在恢复演练（第 ${drill.line} 行）之后。`,
    '演练会临时 REVOKE 再恢复 `public.favorites(id)`；把探针排在它之后，读数描述的是「刚被恢复过」的库，',
    '而不是「一次授权之后就不再动过」的库。',
    '改法：把探针步挪到演练之前（⛔ 不要挪演练：它必须是最后一步）。',
  ].join('\n'));
  assert.equal(drill.line, steps[steps.length - 1].line, [
    `恢复演练不是最后一步（它在第 ${drill.line} 行，最后一步是第 ${steps[steps.length - 1].line} 行）。`,
    '`tests/unit/deploy-sql-gate-recovery.test.mjs` 的测试② 要求演练收尾；本文件也钉一次，',
    '免得把探针追加到 job 末尾的人在那边看到一个「莫名其妙」的红。',
  ].join('\n'));
});

test('③ 该步没有任何吞红构造，全 workflow 也没有 continue-on-error', () => {
  const { probe } = probeStep();
  const offenders = [];
  for (const [label, pattern] of SOFT_FAILURE_PATTERNS) {
    for (const line of probe.lines) {
      const text = line.trim();
      if (text.startsWith('#')) continue;
      if (pattern.test(line)) offenders.push(`${label} → 第 ${probe.line} 行起：${text}`);
    }
  }
  assert.deepEqual(offenders, [], `探针步里出现了会吞掉失败的写法：\n${offenders.join('\n')}\n`
    + '该步的全部意义就是「判红」；`|| true` / `set +e` / `if:` / `continue-on-error` 会让它退化成装饰品。'
    + '要接退出码只允许 `rc=0; if psql …; then rc=0; else rc=$?; fi`。');

  const workflowLines = readRepoText(WORKFLOW_FILE).split('\n');
  const soft = workflowLines
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter(({ text }) => !text.startsWith('#') && /continue-on-error\s*:\s*true/.test(text));
  assert.deepEqual(soft, [], `全 workflow 里出现了 \`continue-on-error: true\`：\n${soft.map(hit => `第 ${hit.line} 行`).join('、')}`);
});

test('④ 三条判据齐全：退出码 0 / 标记逐条 / 42501 条数恰好——且三条都能判红', () => {
  const { probe } = probeStep();
  const body = runBodyOf(probe);

  assert.match(body, /rc=0[\s\S]{0,200}?rc=\$\?/, [
    '探针步没有「先置 rc=0，失败时 rc=$?」的退出码捕获。',
    '探针文件自带 ON_ERROR_STOP=0，psql 正常收尾也是 0 ⇒ 必须把 psql 自己的退出码单独接住并判定，',
    '⛔ 不能用 `|| true`（那是吞掉），也不要靠 `set -e`（它不会让「psql 退出码非 0」变成红）。',
  ].join('\n'));
  assert.match(body, /if\s+\[\s*"\$\{rc\}"\s+-ne\s+0\s*\]/, '探针步没有 `if [ "${rc}" -ne 0 ]` 的判红分支：'
    + '连不上库/脚本被截断这类「根本没跑到」的情形，只能靠退出码这条判据抓住。');

  const markChecks = indexOfAll(body, 'grep -F -q -- "${marker}" "${out}"');
  assert.equal(markChecks.length, 1, `标记判据必须只有一处 \`grep -F -q -- "\${marker}"\`（现为 ${markChecks.length} 处）：`
    + '标记清单只有一个出处，改一处就够；散成多条手写 grep 时改一处漏一处。');
  assert.match(body, /missing=\$\(\(missing \+ 1\)\)/, '标记判据没有 `missing=$((missing + 1))` 计数：逐条判红后还要汇总，'
    + '否则「缺 3 条」只会在日志里滚过去。');
  assert.match(body, /if\s+\[\s*"\$\{missing\}"\s+-ne\s+0\s*\]/, '标记判据没有 `if [ "${missing}" -ne 0 ]` 的汇总判红分支。');

  assert.match(body, /if\s+\[\s*"\$\{total_errors\}"\s+-ne\s+"\$\{expected_42501\}"\s*\]/, [
    '探针步没有「ERROR 行数 ≠ expected_42501 ⇒ 红」的判据。',
    '只 grep 标记挡不住「多授权」：禁止面被授了 INSERT/DELETE 时，探针照样打印全部段落行，',
    '少掉的只是那几条 42501 ⇒ 必须用「恰好等于期望条数」来判。',
  ].join('\n'));
  assert.match(body, /if\s+\[\s*"\$\{forbidden_errors\}"\s+-ne\s+"\$\{expected_42501\}"\s*\]/, [
    '探针步没有「其中 42501 条数 ≠ expected_42501 ⇒ 红」的判据。',
    '它防的是「错误类别变了」：条数凑巧对上、但有的是 42P01/42703 之类（表名写错、列被删）时，',
    '只看总条数会误判成绿。',
  ].join('\n'));

  assert.ok(body.includes('cat "${out}"'), [
    '探针步判红时没有 `cat "${out}"`：探针的全部 stdout/stderr 必须先落文件，',
    '失败时整份打出来（否则 ::error:: 里只剩一句结论，定位不到是哪条语句被误拒权）。',
  ].join('\n'));
  assert.ok((body.match(/::error::/g) ?? []).length >= 4, `探针步的 \`::error::\` 只有 ${(body.match(/::error::/g) ?? []).length} 条`
    + '（要求 ≥4：退出码、缺标记、ERROR 条数、42501 条数、汇总判红各要有可读说明）。');
  assert.match(body, /^\s*exit 1\s*$/m, '探针步判红后没有 `exit 1`：`::error::` 只是注解，'
    + '它不会改变 step 的结论（GitHub 里注解 ⛔ 不等于失败）。');
});

test('⑤ 标记清单非空，且每条都能在探针源码里找到出处（改坏一个字就红）', () => {
  const { probe } = probeStep();
  const source = probeSource();
  const markers = markersOf(runBodyOf(probe));

  assert.ok(markers.length >= 12, `标记只有 ${markers.length} 条（要求 ≥12）：太少时探针断在某一段也可能全中。`
    + '至少覆盖 8 段的结构行（`###` 段头 + 段末 `-- [n] … 探针结束`）与 9 个禁止面对象。');
  assert.equal(new Set(markers).size, markers.length, '标记清单里有重复项（重复的 grep 不增加覆盖，只增加噪音）。');

  // 每条标记都必须能追溯到探针源码：段落行逐字出现；42501 文案则要求「对象名」在源码里被点到。
  const untraceable = [];
  const denyObjects = new Set();
  for (const marker of markers) {
    const deny = /^permission denied for (?:table|schema|function) (\w+)$/.exec(marker);
    if (deny) {
      denyObjects.add(deny[1]);
      if (!source.includes(deny[1])) untraceable.push(`${marker}（对象 ${deny[1]} 在探针源码里搜不到）`);
      continue;
    }
    if (!source.includes(marker)) untraceable.push(`${marker}（在探针源码里搜不到这一行）`);
  }
  assert.deepEqual(untraceable, [], [
    '有标记在探针源码里找不到出处 —— 这类标记永远不会命中，等于把判据改成「必红」；',
    '或反过来：探针改了段落文案而 workflow 没跟，判据描述的是不存在的输出。',
    `逐条：\n${untraceable.join('\n')}`,
    `探针源码：${PROBE_SQL}`,
  ].join('\n'));

  assert.deepEqual([...denyObjects].sort(), [...DENY_OBJECTS].sort(), [
    '禁止面的对象集合不对：应为 5 张表 ＋ 2 个 schema ＋ 2 个函数。',
    `实际覆盖：${[...denyObjects].sort().join(' / ') || '(空)'}`,
    '少一个对象就少一条「必须 42501」的证据；多一个对象则说明标记指向了探针里不存在的授权面。',
  ].join('\n'));

  // 结构行（段头 + 段末）必须整段覆盖：它们证明「跑完了 8 段」，而不是断在第 2 段就停。
  const required = [
    '### 0) 环境',
    '### 探针结束',
    '-- [5] 收藏／历史／对话域探针结束',
    '-- [6] 识别域探针结束',
    '-- [7] 语音域探针结束',
    '-- [8] 函数面探针结束',
  ];
  const missing = required.filter(marker => !markers.includes(marker));
  assert.deepEqual(missing, [], `标记清单缺少结构行：${missing.join(' / ')}。`
    + '这些 `\\echo` 行是「探针真的走完该段」的唯一证据（ON_ERROR_STOP=0 ⇒ 中止不会体现在退出码上）。');
});

test('⑥ expected_42501 必须等于从探针源码数出来的禁止面条数', () => {
  const { probe } = probeStep();
  const body = runBodyOf(probe);
  const declared = /expected_42501=(\d+)/.exec(body);
  assert.ok(declared, '探针步里没有 `expected_42501=<数字>`：错误条数判据必须有一个显式的期望值，'
    + '⛔ 不能写成「> 0 就绿」（那样禁止面只剩 1 条也绿）。');
  const derived = countDenyStatements(probeSource());
  assert.equal(Number(declared[1]), derived, [
    `workflow 写的 expected_42501=${declared[1]}，而从 ${PROBE_SQL} 数出来是 ${derived} 条禁止面语句。`,
    '两边必须一致：探针增删了禁止面（或 FOR UPDATE / 函数调用改形）而 workflow 没跟时，',
    '「恰好等于期望值」这条判据会稳定判红 —— 那正是它的价值，但也必须在这里先红一次，',
    '提示改动者同步更新 workflow 与证据页。',
  ].join('\n'));
  assert.ok(derived > 0, '从探针源码数出的禁止面条数是 0：探针的禁止面没了（或被改成注释），判据失去对象。');
});

test('⑦ 证据页存在，且 workflow 指向它（读数不能只活在 commit message 里）', () => {
  const absolute = join(REPO_ROOT, EVIDENCE_PAGE);
  assert.ok(existsSync(absolute), `找不到证据页 ${EVIDENCE_PAGE}：本步的真跑读数（绿 / 撤一条授权后红 / 复原后绿）`
    + '必须落在仓内文档里，否则「为什么这 17 条标记、为什么恰好 18 条 42501」无从复核。');
  const workflow = readRepoText(WORKFLOW_FILE);
  assert.ok(workflow.includes(EVIDENCE_PAGE), `\`${WORKFLOW_FILE}\` 里没有引用 ${EVIDENCE_PAGE}：`
    + '探针步的注释必须指向口径出处（改证据页路径时同步改 workflow 的两处引用）。');
});
