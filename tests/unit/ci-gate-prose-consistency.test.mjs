// CI workflow「散文声称的组数/门槛」与「该 job 真正的闸门数字」一致性守卫（静态，不需要起数据库）。
//
// 为什么要这一条（真实事故，两轮）：
//   · `#1093` 之前，`.github/workflows/real-pg-integration.yml` 的 `real-pg-http-17-11` job 注释头长期写
//     「8 组」，而同一 job 的闸门是 `pass_groups -lt 11`；`#1093` 只改掉了三条注释，闸门这一侧当时**没有**
//     对应的读数闸 —— 于是「散文 8 / 闸门 11」这种漂移只能靠人肉审查发现，`#1096` 才把 `-lt 11` 补上。
//   · 同一次事故里 `tests/unit/ci-integration-chain-structure.test.mjs` 的 `reason` 散文也写着「8 组」，
//     与真实读数 11 组不符；散文和闸门分处两个文件、两套判据，谁也不会因为对方变了而红。
// 本文件只做一件事：把「同一 job（同一 step）里，散文声称的组数」与「真正的 `-lt` 闸门数字」**对上**。
// 它不评判散文写得对不对、不替代人工语义审查、也不改任何 workflow。
//
// 判据（①…⑦）：
//   ① 扫描面：`.github/workflows/*.yml` 全量，且必须包含 `real-pg-integration.yml` 与 `engineering-shell.yml`
//      （这两个是本次交付点名要求的；少一个即红）。
//   ② job 分块：`^jobs:` 之后 `^  <key>:` 的 key 行切分；**块首**是从 key 往上连续的 `#` 注释（散文通常写在
//      job 之前，见 `real-pg-integration.yml:1699` 的「`N ≥ 11`」在 `:1707` 的 job key 之上），**块尾**是下一个
//      job 的**注释头**起点（⛔ 不是下一个 key 行 —— 否则上一个 job 会把下一个 job 的注释头吞掉，同一处散文被
//      数两遍）。
//   ③ 闸门真值：`"$var" -lt N` / `"$var" -ne N` / `"$var" != N` 形态的数值比较。`-ne 0` / `!= 0` 归为
//      **rc 闸**（退出码，不是读数），不进比较；`pg_isready`、`timeout-minutes`、`5432:5432` 这类端口/超时数字
//      根本不是比较式，**按构造**不会被匹配（判据⑦ 有反例 fixture 钉这一点）。
//   ④ 散文声称：`N 组`、`N 条读数`、`基线 N`、`共 N 组`、`≥ N`（含 `>= N`）、`< N` 六种形态的数字。
//      ⛔ 不把裸 `= N` 当门槛（「3 条前置 + 装包 5 + 两条臂各 5 = 22」是加法，不是 ≥）。
//   ⑤ 对应关系（先按语义、再按位置，**判不了就登记**，绝不默认放行）：
//      (a) 散文行里直接写了某个闸门变量名（如 `pass_groups`）⇒ 绑那道闸；
//      (b) 否则，散文所在 step 内**唯一**的 `-lt` 闸 ⇒ 绑它（step 首 = 从 `- ` 往上连续的注释行，注释说的就是
//          这一步）；
//      (c) 否则，所在 job 内**唯一**的 `-lt` 闸 ⇒ 绑它；
//      (d) 都不成立 ⇒ 记 `unbound`（判不了），必须进允许清单。
//   ⑥ 允许清单**会失效**：每条都必须仍能复现出「同一 file/job/line/claim、同一 kind、同一 gate」的 finding；
//      散文被修好、闸门被改、行号漂了 —— 都会让条目变成 stale 而判红。⛔ 不允许把清单当永久豁免。
//   ⑦ 每个带 `-lt` 闸门的 job 里，每道闸门都必须至少有一处散文钉住（`unclaimed` finding），否则「闸门是隐形的」：
//      改散文没人红、改闸门也没人红。本文件今天 16/16 全钉住。
//
// 允许清单为什么存在：`.github/**` 属 B 档，本单（GY-R90）**明确禁止**改 yml ⇒ 今天扫出来的每一处判不了/不一致
// 只能就地登记，逐条写「为什么本轮不改 + 应该由谁改」。清单里每一条都会在每次跑测试时重新验证（判据⑥）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = '.github/workflows';

// 本单点名要求覆盖的两个 workflow（判据①）；其余 `*.yml` 一并扫。
const REQUIRED_WORKFLOWS = ['engineering-shell.yml', 'real-pg-integration.yml'];

// 「读数比较」运算符：只有这些能当组数/条数闸门。`-ne 0` / `!= 0` 是 rc 闸，单独归类（判据③）。
const COUNT_OPS = new Set(['-lt', '-le', '-gt', '-ge']);
const RC_OPS = new Set(['-ne']);
const MAX_NUMERIC = 100000;

// ---------------------------------------------------------------------------
// 允许清单（判据⑥：每条都必须仍能复现同一 finding，修好即失效）
// key = `${file}#${job}:${line}:${claim}`；kind: 'mismatch' | 'unbound' | 'unclaimed'
// ---------------------------------------------------------------------------
const ALLOWLIST = [
  // ---- real-pg-17-11：这道 job 有 7 道读数闸，散文里的数字大多不是闸门数字 ------------------
  {
    key: 'real-pg-integration.yml#real-pg-17-11:240:5:unbound',
    kind: 'unbound',
    gate: null,
    why: '「自建 5 组角色 + 运行时 LOGIN」数的是合成脚本造的几个数据库角色，不是读数门槛；所在 step 没有 -lt 闸，而 job 有 7 道闸 ⇒ 位置规则判不了。',
    owner: 'GY-R90 之后改 `.github/workflows/real-pg-integration.yml` 的 B 档单（写手改散文明说「角色」，审查者核）',
  },
  {
    key: 'real-pg-integration.yml#real-pg-17-11:243:13:unbound',
    kind: 'unbound',
    gate: null,
    why: '「exit=0，PASS 13 组」是本地取证记录的一次实测读数，不是门槛；step 无闸、job 7 道闸 ⇒ 判不了。',
    owner: '同上 B 档单（或把取证读数挪到 workflow 之外的证据页，注释只留「见证据页」）',
  },
  {
    key: 'real-pg-integration.yml#real-pg-17-11:258:13:unbound',
    kind: 'unbound',
    gate: null,
    why: '同 :243，另一处「PASS 13 组」本地取证记录；散文记的是某次运行读数，不是闸门。',
    owner: '同上 B 档单',
  },
  {
    key: 'real-pg-integration.yml#real-pg-17-11:351:23:mismatch',
    kind: 'mismatch',
    gate: 41,
    why: '同一行既有真值「读数 41 组」又有历史值「旧值 23 组已过时」；23 被当成第二处声称 ⇒ 与闸门 41 判成不一致。语义上它已标注「已过时」，属扫描器已知假阳性形态，本轮不改 yml、也不放宽扫描器（放宽会漏真漂移）。',
    owner: '改 yml 的 B 档单：把「旧值 23 组已过时」改成不带数字的措辞（如「旧值已过时」），改完删本条',
  },
  {
    key: 'real-pg-integration.yml#real-pg-17-11:545:17:unbound',
    kind: 'unbound',
    gate: null,
    why: '「`17 条读数，全部断言通过`」是该 step 自己脚本打印的读数条数，该 step 内没有 -lt 闸（闸门在同类臂的别的 step）⇒ 判不了。',
    owner: '同上 B 档单',
  },
  {
    key: 'real-pg-integration.yml#real-pg-17-11:585:13:unbound',
    kind: 'unbound',
    gate: null,
    why: '「`RESULT=PASS 13 组`」是本地取证输出摘录（一次实测），不是门槛；step 无闸。',
    owner: '同上 B 档单',
  },
  {
    key: 'real-pg-integration.yml#real-pg-17-11:684:8:unbound',
    kind: 'unbound',
    gate: null,
    why: '「它自证 8 组」说的是该臂脚本自己的读数条数；这一步没有 -lt 闸，job 7 道闸 ⇒ 判不了。',
    owner: '同上 B 档单',
  },
  {
    key: 'real-pg-integration.yml#real-pg-17-11:737:8:unbound',
    kind: 'unbound',
    gate: null,
    why: '「8 组读数：①首次…」描述该 step 的 8 条读数构成，闸门不在这一步；job 有 7 道闸故判不了。',
    owner: '同上 B 档单',
  },
  {
    key: 'real-pg-integration.yml#real-pg-17-11:750:8:unbound',
    kind: 'unbound',
    gate: null,
    why: '「43 个迁移 + 8 组读数」是超时预算的加法项（≈40 s 的实测构成），不是门槛；step 无闸。',
    owner: '同上 B 档单',
  },
  {
    key: 'real-pg-integration.yml#real-pg-17-11:753:8:unbound',
    kind: 'unbound',
    gate: null,
    why: '「`[A]`–`[H]` 8 组读数 + 末行 `[ALL PASS]`」说明该臂读数形态，不是闸门数字；step 无闸。',
    owner: '同上 B 档单',
  },
  {
    key: 'real-pg-integration.yml#real-pg-17-11:780:11:unbound',
    kind: 'unbound',
    gate: null,
    why: '「全链 46 个迁移 + 11 组读数」同样是超时预算加法项（≈20 s 的构成），不是门槛；step 无闸。',
    owner: '同上 B 档单',
  },
  {
    key: 'real-pg-integration.yml#real-pg-17-11:844:13:mismatch',
    kind: 'mismatch',
    gate: 19,
    why: '这一行讲基线演进：「旧基线 13 时删掉 ⑩/⑪ 仍剩 16 ≥ 13、step 照样绿 … 抬到 19」。13/16 是历史值，19 才是现闸门；扫描器按数字取第一处 ⇒ 13 与 19 判成不一致。属已知假阳性形态，本轮不放宽扫描器。',
    owner: '改 yml 的 B 档单：历史值写成「旧基线」（本文件已把「基线 N」当声称）之外的措辞，或挪出闸门注释段；改完删本条',
  },
];

// ---------------------------------------------------------------------------
// 扫描器
// ---------------------------------------------------------------------------

/** 取 `^jobs:` 之后的 job 块：块首含 key 上方的连续 `#` 注释，块尾 = 下一个 job 的注释头起点。 */
function splitJobs(lines) {
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt < 0) return [];
  const keys = [];
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (m) keys.push({ name: m[1], at: i });
  }
  const heads = keys.map((key) => {
    let top = key.at;
    while (top - 1 > jobsAt && /^\s*#/.test(lines[top - 1])) top -= 1;
    return top;
  });
  return keys.map((key, idx) => ({
    name: key.name,
    keyIdx: key.at,
    headIdx: heads[idx],
    endIdx: idx + 1 < keys.length ? heads[idx + 1] : lines.length,
  }));
}

/** 取 job 内的 step：首行是 `steps:` 之下、同一缩进的 `- `，step 首含它上方的连续同缩进 `#` 注释。 */
function splitSteps(lines, job) {
  const stepsAt = lines.findIndex((line, i) => i > job.keyIdx && i < job.endIdx && /^\s+steps:\s*$/.test(line));
  if (stepsAt < 0) return [];
  let indent = null;
  const starts = [];
  for (let i = stepsAt + 1; i < job.endIdx; i += 1) {
    const m = /^(\s+)- /.exec(lines[i]);
    if (!m) continue;
    if (indent === null) indent = m[1];
    if (m[1] === indent) starts.push(i);
  }
  const tops = starts.map((start) => {
    let top = start;
    while (top - 1 > stepsAt && new RegExp(`^${indent}#`).test(lines[top - 1])) top -= 1;
    return top;
  });
  // 块尾 = 下一个 step 的**注释头**起点（与 job 分块同一条纪律：拿下一个 step 的首行当界会把它的注释头
  // 吞进上一步，同一处散文被数两遍）。
  return starts.map((start, idx) => ({
    topIdx: tops[idx],
    startIdx: start,
    endIdx: idx + 1 < tops.length ? tops[idx + 1] : job.endIdx,
  }));
}

const GATE_RES = [
  // `[ "$readings" -lt 8 ]` / `[ -z "${readings:-}" ] || [ "$readings" -lt 12 ]`
  /"\$\{?([A-Za-z_][A-Za-z0-9_]*)[^"]*"?\s*(-lt|-le|-gt|-ge|-ne)\s+(\d+)/g,
  // `[ "$x" != "17" ]` 形态（右侧带引号的数字）
  /"\$\{?([A-Za-z_][A-Za-z0-9_]*)[^"]*"?\s*!=\s*"?(\d+)"?/g,
];

/** 抽出 [from, to) 内的数值比较（判据③）。 */
function gatesIn(lines, from, to) {
  const out = [];
  for (let i = from; i < to; i += 1) {
    const line = lines[i];
    if (!line.includes('$')) continue;
    for (const re of GATE_RES) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        const varName = m[1];
        const isNe = m[2] === '!=' || m[2] === '-ne';
        const op = m[2] === undefined ? '!=' : m[2];
        const n = Number(m[3] ?? m[2]);
        if (!Number.isFinite(n) || n > MAX_NUMERIC) continue;
        const kind = !isNe && COUNT_OPS.has(op) && n > 0 ? 'count' : 'rc';
        out.push({ varName, op, n, line: i + 1, kind, text: line.trim() });
      }
    }
  }
  // 同一行同一变量同一数字只留一条（`[ -z ... ] || [ ... -lt 12 ]` 会命中两次时去重）
  const seen = new Set();
  return out.filter((g) => {
    const key = `${g.varName}|${g.op}|${g.n}|${g.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 散文形态（判据④）。顺序即优先级；同一行同一数字只记一次。
const PROSE_FORMS = [
  [/(\d+)\s*组/g, 'N组'],
  [/(\d+)\s*条读数/g, 'N条读数'],
  [/基线\s*(\d+)/g, '基线N'],
  [/(?:≥|>=)\s*(\d+)/g, '≥N'],
  [/<\s*(\d+)/g, '<N'],
  [/共\s*(\d+)\s*组/g, '共N组'],
];

/** 抽出 [from, to) 内的散文声称（判据④）。 */
function claimsIn(lines, from, to) {
  const out = [];
  for (let i = from; i < to; i += 1) {
    const line = lines[i];
    const numbers = new Set();
    for (const [re, form] of PROSE_FORMS) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        const n = Number(m[1]);
        if (!Number.isFinite(n) || numbers.has(n)) continue;
        numbers.add(n);
        out.push({ n, form, line: i + 1, text: line.trim() });
      }
    }
  }
  return out;
}

function keyOf(file, jobName, claim, kind) {
  return `${file}#${jobName}:${claim.line}:${claim.n}${kind === 'match' ? '' : `:${kind}`}`;
}

/**
 * 扫描一份 workflow 文本，返回 job / gate / claim / finding 四表（判据③④⑤⑦）。
 * 纯函数：fixture 可以直接喂字符串（判据③④⑤ 的负控制就靠这一点）。
 */
function scanWorkflow(file, text) {
  const lines = text.split(/\r?\n/);
  const jobs = [];
  const findings = [];
  for (const job of splitJobs(lines)) {
    const steps = splitSteps(lines, job);
    const gates = gatesIn(lines, job.keyIdx, job.endIdx);
    const countGates = gates.filter((g) => g.kind === 'count');
    const rcGates = gates.filter((g) => g.kind === 'rc');
    const headerClaims = claimsIn(lines, job.headIdx, job.keyIdx);
    const stepClaims = [];
    for (const step of steps) stepClaims.push(...claimsIn(lines, step.topIdx, step.endIdx).map((c) => ({ ...c, step })));
    // job 级散文 = key 上方的注释头 ∪ key 与第一条 step 之间那些「没被任何 step 覆盖」的 job 级注释
    // （4 空格缩进，比 step 的 `- ` 浅）。不这么做，写在 `name:`/`runs-on:` 之间的散文就是扫描盲区。
    const inAnyStep = (line) => steps.some((s) => line > s.topIdx && line <= s.endIdx);
    const jobLevelClaims = [];
    for (let i = job.keyIdx + 1; i < job.endIdx; i += 1) {
      if (inAnyStep(i + 1)) continue;
      if (!/^ {0,5}#/.test(lines[i])) continue;
      jobLevelClaims.push(...claimsIn(lines, i, i + 1));
    }

    // 只有存在组数闸门的 job 才参与一致性判定（没有闸门就没有「闸门声称」，见证据页「不声称」）。
    const claims = [
      ...headerClaims.map((c) => ({ ...c, scope: 'header' })),
      ...jobLevelClaims.map((c) => ({ ...c, scope: 'job' })),
      ...stepClaims.map((c) => ({ ...c, scope: 'step' })),
    ];
    const jobFindings = [];
    if (countGates.length > 0) {
      for (const claim of claims) {
        const bound = bindClaim(claim, countGates, steps);
        const kind = bound === null ? 'unbound' : bound.n === claim.n ? 'match' : 'mismatch';
        const finding = {
          file,
          job: job.name,
          line: claim.line,
          claim: claim.n,
          form: claim.form,
          kind,
          gate: bound === null ? null : bound.n,
          gateVar: bound === null ? null : bound.varName,
          gateLine: bound === null ? null : bound.line,
          how: bound === null ? null : bound.how,
          text: claim.text,
        };
        finding.key = keyOf(file, job.name, claim, kind);
        jobFindings.push(finding);
      }
      // 判据⑦：每道组数闸门都得有散文钉住
      for (const gate of countGates) {
        const covered = jobFindings.some((f) => f.gateLine === gate.line && f.kind === 'match');
        if (!covered) {
          const finding = {
            file,
            job: job.name,
            line: gate.line,
            claim: gate.n,
            form: 'gate-without-prose',
            kind: 'unclaimed',
            gate: gate.n,
            gateVar: gate.varName,
            gateLine: gate.line,
            how: null,
            text: gate.text,
          };
          finding.key = keyOf(file, job.name, { line: gate.line, n: gate.n }, 'unclaimed');
          jobFindings.push(finding);
        }
      }
    }
    findings.push(...jobFindings);
    jobs.push({ name: job.name, keyLine: job.keyIdx + 1, headLine: job.headIdx + 1, gates, countGates, rcGates, claims, findings: jobFindings });
  }
  return { file, jobs, findings };
}

/**
 * 判据⑤的绑定顺序：(a) 散文行点名闸门变量 → (b) step 内唯一组数闸 → (c) job 内唯一组数闸 → (d) null（判不了）。
 */
function bindClaim(claim, countGates, steps) {
  const named = countGates.filter((g) => new RegExp(`(^|[^A-Za-z0-9_])${g.varName}([^A-Za-z0-9_]|$)`).test(claim.text));
  if (named.length === 1) return { ...named[0], how: 'var-name' };
  // 点了多个变量（或一个都不点）⇒ 不下结论，交给位置规则；位置也判不了才是 unbound。
  const step = claim.step ?? steps.find((s) => claim.line > s.topIdx && claim.line <= s.endIdx);
  if (step) {
    const inStep = countGates.filter((g) => g.line > step.topIdx && g.line <= step.endIdx);
    if (inStep.length === 1) return { ...inStep[0], how: 'step-unique' };
    if (inStep.length > 1) return null;
  }
  if (countGates.length === 1) return { ...countGates[0], how: 'job-unique' };
  return null;
}

const isOffender = (finding) => finding.kind !== 'match';

/** 判据⑤：清单外的 finding ⇒ 直接判红，并把清单打印出来（不做「静默跳过」）。 */
function assertNoUnlistedFindings(scan, allowlist) {
  const allowed = new Set(allowlist.map((entry) => entry.key));
  const offenders = scan.findings.filter((f) => isOffender(f) && !allowed.has(f.key));
  assert.deepEqual(
    offenders.map((f) => `${f.key}  gate=${f.gate ?? '(none)'}  claim=${f.claim}  ${f.text.slice(0, 120)}`),
    [],
    `发现 ${offenders.length} 处「散文与闸门不一致 / 判不了」却不在允许清单里。\n` +
      '要么把散文改对（`.github/**` 属 B 档，改之前先看本单是否允许），要么在 ALLOWLIST 里逐条登记理由与责任人。',
  );
}

/** 判据⑥：清单条目必须仍能复现同一 finding；修好了/行号漂了 ⇒ 条目 stale ⇒ 判红。 */
function assertNoStaleAllowlist(scan, allowlist) {
  const byKey = new Map(scan.findings.map((f) => [f.key, f]));
  const stale = [];
  for (const entry of allowlist) {
    const found = byKey.get(entry.key);
    if (!found) {
      stale.push(`${entry.key} ⇒ 已扫不到这条 finding（散文/闸门被改好，或行号漂了）`);
      continue;
    }
    if (found.kind !== entry.kind) stale.push(`${entry.key} ⇒ kind 从 ${entry.kind} 漂成 ${found.kind}`);
    if ((found.gate ?? null) !== (entry.gate ?? null)) stale.push(`${entry.key} ⇒ gate 从 ${entry.gate} 漂成 ${found.gate}`);
  }
  assert.deepEqual(stale, [], `允许清单有 ${stale.length} 条已失效（stale）——请删掉对应条目，别让它变成永久豁免。`);
}

/** 判据②：把 `real-pg-integration.yml` 的 `-lt 11` 改成 `-lt 8` 这类变异必须红（不落盘，纯内存）。 */
function mutate(text, from, to, expectCount = 1) {
  const parts = text.split(from);
  assert.equal(parts.length - 1, expectCount, `变异锚点「${from}」在文本里出现 ${parts.length - 1} 次，预期 ${expectCount} 次`);
  return parts.join(to);
}

const FIXTURE_MATCH = `name: fixture-match
on: [push]
jobs:
  gate-job:
    name: fixture
    # 该臂自证 8 组读数：末行 \`[ALL PASS]\` + \`N ≥ 8\`。
    runs-on: ubuntu-24.04
    timeout-minutes: 45
    steps:
      # 本地取证：\`fixture：8 条读数全部通过\`。
      - name: 8 组读数
        timeout-minutes: 5
        run: |
          psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE fixture_test'
          readings=$(awk '/^PASS /{n++} END{print n+0}' "$log")
          if [ "$readings" -lt 8 ]; then
            echo "::error::读数不足基线（\${readings} < 8）⇒ 按未取得处理。"
            exit 1
          fi
`;

const FIXTURE_MISMATCH = `name: fixture-mismatch
on: [push]
jobs:
  gate-job:
    name: fixture
    # 该臂自证 8 组读数：末行 \`[ALL PASS]\` + \`N ≥ 8\`。
    runs-on: ubuntu-24.04
    steps:
      - name: 臂本体
        run: |
          if [ "$pass_groups" -lt 11 ]; then
            echo "::error::只数到 \${pass_groups} 组 PASS（应当 ≥ 11）。"
            exit 1
          fi
`;

const FIXTURE_TWO_GATES = `name: fixture-two-gates
on: [push]
jobs:
  two-gate-job:
    runs-on: ubuntu-24.04
    steps:
      # pass_groups ≥ 11：整组断言被删就红。
      - name: http 臂
        run: |
          # pass_groups ≥ 11
          if [ "$pass_groups" -lt 11 ]; then
            echo "::error::只数到 \${pass_groups} 组 PASS。"
            exit 1
          fi
      # readings ≥ 5：读数行少了就红。
      - name: 读数臂
        run: |
          # readings ≥ 5
          if [ "$readings" -lt 5 ]; then
            echo "::error::读数不足。"
            exit 1
          fi
`;

function readWorkflow(name) {
  return readFileSync(join(REPO_ROOT, WORKFLOW_DIR, name), 'utf8');
}

function scanAllWorkflows() {
  const files = readdirSync(join(REPO_ROOT, WORKFLOW_DIR))
    .filter((name) => name.endsWith('.yml'))
    .sort();
  return files.map((name) => scanWorkflow(name, readWorkflow(name)));
}

function summarize(scans) {
  const counts = { jobs: 0, jobsWithCountGate: 0, countGates: 0, rcGates: 0, claims: 0, match: 0, mismatch: 0, unbound: 0, unclaimed: 0 };
  for (const scan of scans) {
    counts.jobs += scan.jobs.length;
    for (const job of scan.jobs) {
      counts.countGates += job.countGates.length;
      counts.rcGates += job.rcGates.length;
      if (job.countGates.length > 0) counts.jobsWithCountGate += 1;
      counts.claims += job.claims.length;
    }
    for (const f of scan.findings) counts[f.kind] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('判据①：扫描面覆盖全部 workflow，且包含本单点名的两个文件', () => {
  const names = readdirSync(join(REPO_ROOT, WORKFLOW_DIR))
    .filter((name) => name.endsWith('.yml'))
    .sort();
  for (const required of REQUIRED_WORKFLOWS) {
    assert.ok(names.includes(required), `扫描面缺 ${WORKFLOW_DIR}/${required}`);
  }
  const scans = scanAllWorkflows();
  assert.equal(scans.length, names.length);
  // `engineering-shell.yml` 今天没有任何数值比较、也没有组数散文 —— 这条钉住「覆盖到了、且确实是 0」，
  // 免得以后有人以为它被漏扫。
  const shell = scans.find((s) => s.file === 'engineering-shell.yml');
  assert.ok(shell.jobs.length >= 6, `engineering-shell.yml 只切出 ${shell.jobs.length} 个 job`);
  assert.deepEqual(shell.findings, []);
  const counts = summarize(scans);
  // 打印扫描面读数（证据页与 PR 正文引用的就是这几行）。
  console.log(
    `[ci-gate-prose] 扫描面：${scans.length} 个 workflow、${counts.jobs} 个 job（其中 ${counts.jobsWithCountGate} 个带组数闸门）、` +
      `${counts.countGates} 道组数闸门、${counts.rcGates} 道 rc 闸、${counts.claims} 处散文声称、` +
      `匹配 ${counts.match}、不一致 ${counts.mismatch}、判不了 ${counts.unbound}、闸门无散文 ${counts.unclaimed}`,
  );
});

test('判据③：`pg_isready` / `timeout-minutes` / 端口数字不会被当成闸门', () => {
  const text = `name: fixture-noise
on: [push]
jobs:
  noise-job:
    timeout-minutes: 45
    services:
      postgres:
        image: postgres:17.11
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready
          --health-retries 10
          --health-timeout 5s
    steps:
      - run: echo ready
        timeout-minutes: 5
`;
  const scan = scanWorkflow('fixture-noise.yml', text);
  const job = scan.jobs[0];
  assert.deepEqual(job.gates, [], '超时/端口/健康检查数字被误判成闸门');
  assert.deepEqual(scan.findings, []);
});

test('判据④⑤：真实扫描 —— 今天每一处「不一致 / 判不了」都必须与允许清单逐字相等', () => {
  const scans = scanAllWorkflows();
  const offenders = scans.flatMap((s) => s.findings).filter(isOffender).sort((a, b) => a.key.localeCompare(b.key));
  // 「先枚举、再登记」：这条断言失败时就地打印全清单，方便逐条抄进 ALLOWLIST。
  console.log(`[ci-gate-prose] 不一致/判不了 清单（${offenders.length} 条）：`);
  for (const f of offenders) {
    console.log(`  - key=${f.key} kind=${f.kind} gate=${f.gate ?? '(none)'}@${f.gateLine ?? '-'} claim=${f.claim} :: ${f.text.slice(0, 110)}`);
  }
  assert.deepEqual(
    offenders.map((f) => f.key).sort(),
    ALLOWLIST.map((entry) => entry.key).sort(),
    '允许清单与扫描结果不是同一集合：要么有新漂移（改散文或补闸门），要么有条目已被修好（删掉它）',
  );
  for (const scan of scans) {
    // 只校验属于本文件的条目：逐文件遍历时把别的文件的条目也塞进来，它们必然「扫不到」而被误判 stale。
    const mine = ALLOWLIST.filter((entry) => entry.key.startsWith(`${scan.file}#`));
    assertNoUnlistedFindings(scan, mine);
    assertNoStaleAllowlist(scan, mine);
  }
});

test('判据⑥：允许清单每条都记录了 why / owner，且 kind 只能是三类之一', () => {
  for (const entry of ALLOWLIST) {
    assert.equal(typeof entry.why, 'string');
    assert.ok(entry.why.length >= 20, `${entry.key} 的 why 太短：要说清「为什么本轮不改」`);
    assert.ok(/[\u4e00-\u9fa5]/.test(entry.why), `${entry.key} 的 why 必须是能读的中文理由`);
    assert.equal(typeof entry.owner, 'string');
    assert.ok(entry.owner.length >= 2, `${entry.key} 缺 owner（该由谁改）`);
    assert.ok(['mismatch', 'unbound', 'unclaimed'].includes(entry.kind), `${entry.key} 的 kind 非法：${entry.kind}`);
    assert.match(entry.key, /^[A-Za-z0-9._-]+\.yml#[A-Za-z0-9_-]+:\d+:\d+(:(mismatch|unbound|unclaimed))?$/);
  }
});

test('判据⑤：散文与闸门真匹配 ⇒ 通过（fixture）', () => {
  const scan = scanWorkflow('fixture-match.yml', FIXTURE_MATCH);
  const offenders = scan.findings.filter(isOffender);
  assert.deepEqual(offenders.map((f) => f.key), []);
  const job = scan.jobs[0];
  assert.equal(job.countGates.length, 1);
  assert.equal(job.countGates[0].n, 8);
  assert.equal(job.claims.length, 4, '4 处散文：job 级注释「8 组读数 / ≥ 8」+ step 头「8 条读数」+ `- name: 8 组读数` + 报错文案「< 8」');
  assert.deepEqual(job.claims.map((c) => c.n), [8, 8, 8, 8]);
});

test('判据⑤：清单外的幻造不一致 ⇒ 判红（fixture，且不依赖真实文件）', () => {
  const scan = scanWorkflow('fixture-mismatch.yml', FIXTURE_MISMATCH);
  const offenders = scan.findings.filter(isOffender);
  assert.equal(offenders.length, 1, 'job 级注释「8 组读数 / ≥ 8」与闸门 11 不一致（同一行同一数字只记一次）');
  assert.deepEqual(offenders.map((f) => f.kind), ['mismatch']);
  assert.deepEqual(offenders.map((f) => f.claim), [8]);
  assert.deepEqual(offenders.map((f) => f.gate), [11]);
  // 同一份文本 + 空清单 ⇒ assertNoUnlistedFindings 必须抛（这就是 CI 判红的那条路）
  assert.throws(() => assertNoUnlistedFindings(scan, []), /却不在允许清单里/);
  // 登记进去 ⇒ 通过；但把散文改成 11 后条目就 stale（判据⑥）
  const allow = offenders.map((f) => ({ key: f.key, kind: 'mismatch', gate: f.gate, why: 'fixture 里演示允许清单的登记与失效', owner: 'fixture' }));
  assert.doesNotThrow(() => assertNoUnlistedFindings(scan, allow));
  assert.doesNotThrow(() => assertNoStaleAllowlist(scan, allow));
  const fixed = scanWorkflow('fixture-mismatch.yml', FIXTURE_MISMATCH.replace(/8 组读数/g, '11 组读数').replace(/≥ 8/g, '≥ 11'));
  assert.throws(() => assertNoStaleAllowlist(fixed, allow), /已失效（stale）/);
});

test('判据⑤：多道闸门时按变量名选对（fixture）', () => {
  const scan = scanWorkflow('fixture-two-gates.yml', FIXTURE_TWO_GATES);
  const offenders = scan.findings.filter(isOffender);
  assert.deepEqual(offenders.map((f) => f.key), []);
  const job = scan.jobs[0];
  assert.equal(job.countGates.length, 2);
  const byVar = Object.fromEntries(job.claims.map((c) => [c.form + ':' + c.n, c]));
  const bound = job.findings.map((f) => `${f.gateVar}=${f.gate}:${f.how}`);
  assert.ok(bound.every((b) => /^(pass_groups=11|readings=5):(var-name|step-unique)$/.test(b)), `绑定结果异常：${bound.join(', ')}`);
  assert.equal(job.findings.length, 4, 'job 头两处 + 两个 step 各一处');
  // 反向：把 `readings ≥ 5` 写成 `readings ≥ 11` ⇒ 必须红（变量名绑定不允许「就近凑合」）
  const broken = scanWorkflow('fixture-two-gates.yml', FIXTURE_TWO_GATES.replace('readings ≥ 5', 'readings ≥ 11'));
  const bad = broken.findings.filter(isOffender);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].claim, 11);
  assert.equal(bad[0].gate, 5);
  assert.equal(bad[0].gateVar, 'readings');
  assert.equal(bad[0].kind, 'mismatch');
});

test('判据⑦：真实文件里 16 道组数闸门全部有散文钉住，且 http 臂那道就是 11（事故锚点）', () => {
  const scan = scanWorkflow('real-pg-integration.yml', readWorkflow('real-pg-integration.yml'));
  const gates = scan.jobs.flatMap((job) => job.countGates);
  assert.equal(gates.length, 16, `real-pg-integration.yml 的组数闸门从 16 道变成了 ${gates.length} 道`);
  const unclaimed = scan.findings.filter((f) => f.kind === 'unclaimed');
  assert.deepEqual(unclaimed.map((f) => `${f.job}:${f.line}`), [], '有闸门没有任何散文钉住 ⇒ 闸门是隐形的');
  const http = scan.jobs.find((job) => job.name === 'real-pg-http-17-11');
  assert.ok(http, 'real-pg-http-17-11 job 不见了');
  assert.deepEqual(http.countGates.map((g) => `${g.varName}-lt${g.n}@${g.line}`), ['pass_groups-lt11@1787']);
  const httpClaims = http.claims.map((c) => `${c.line}:${c.n}`).sort();
  assert.deepEqual(
    httpClaims,
    ['1676:11', '1678:11', '1699:11', '1788:11'],
    'http 臂四处散文（1676/1678「11 组 PASS」+ 1699「N ≥ 11」+ 1788「应当 ≥ 11」）必须全是 11',
  );
});

test('判据②：变异自证 —— 把 `-lt 11` 改成 `-lt 8` 必须红（内存变异，不落盘）', () => {
  const original = readWorkflow('real-pg-integration.yml');
  const mutated = mutate(original, 'pass_groups" -lt 11', 'pass_groups" -lt 8');
  const scan = scanWorkflow('real-pg-integration.yml', mutated);
  const httpFindings = scan.findings.filter((f) => f.job === 'real-pg-http-17-11' && f.kind !== 'match');
  const mism = httpFindings.filter((f) => f.kind === 'mismatch');
  // 闸门从 11 变 8 ⇒ 4 处「11」的散文全部翻成不一致（1676 / 1678 / 1699 / 1788）
  assert.equal(mism.length, 4, `闸门被改小后应正好 4 处散文不再匹配，实测 ${mism.length}：${mism.map((f) => f.key).join(', ')}`);
  assert.deepEqual(
    mism.map((f) => `${f.key} gate=${f.gate} var=${f.gateVar}`),
    mism.map((f) => `${f.key} gate=8 var=pass_groups`),
    '变异后必须每一条都判成「与变异后的闸门 8 不一致」，否则守卫没生效',
  );
  // 判据⑦ 同步红：闸门 8 已经没有任何散文钉住（原来钉它的 11 全翻了）
  assert.deepEqual(
    httpFindings.filter((f) => f.kind === 'unclaimed').map((f) => `${f.key} gate=${f.gate}`),
    ['real-pg-integration.yml#real-pg-http-17-11:1787:8:unclaimed gate=8'],
    '变异后闸门 8 应变成「无散文钉住」，判据⑦ 必须同时红',
  );
  assert.throws(
    () => assertNoUnlistedFindings(scan, ALLOWLIST.filter((entry) => !entry.key.startsWith('real-pg-integration.yml#real-pg-http-17-11'))),
    /却不在允许清单里/,
  );
  // 反向变异：把报错文案的「应当 ≥ 11」改成「应当 ≥ 8」⇒ 同样是 mismatch（散文侧变异）
  const proseMutated = mutate(original, '（应当 ≥ 11）', '（应当 ≥ 8）');
  const proseScan = scanWorkflow('real-pg-integration.yml', proseMutated);
  const proseBad = proseScan.findings.filter((f) => f.kind === 'mismatch' && f.job === 'real-pg-http-17-11');
  assert.equal(proseBad.length, 1);
  assert.equal(proseBad[0].claim, 8);
  assert.equal(proseBad[0].gate, 11);
});
