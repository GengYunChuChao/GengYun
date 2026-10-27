/**
 * GY-R67-C2 · 另外 5 份「每份承载 1–4 条真库臂」的 workflow 的结构守卫。
 *
 * 背景（`.pg17/audit/r67-d-tests-ci.md` 的 GY-R67-D02）：判据⑨ 只锚 `real-pg-integration.yml`，
 * `auth-privacy-postgres.yml` 另有专用守卫（`tests/unit/auth-privacy-arm-isolation.test.mjs`），
 * 而 `catalog-` / `source-lifecycle-` / `staging-intake-` / `workbook-staging` / `consent-grant-postgres.yml`
 * 这 5 份**零结构守卫** —— 删掉一个承载真库臂的 step、删掉 job、把库名/URL 变量改错，
 * 全仓没有任何门禁会响，而「真库覆盖」在读数上是静默下降的。
 *
 * 本文件只做**结构**判据（不读臂的断言内容，不代替臂本身）：
 *   ① 每份 workflow 的 job 名恰为登记值、且 `runs-on` 是 ubuntu；
 *   ② job 级 `timeout-minutes` 存在且 ≤ 30（超时会把「没跑到」混成「job 超时」，读数与失败不可区分）；
 *   ③ `services.postgres.image` 必须与登记值逐字一致（`workbook-staging` 现为 `postgres:17`，换版本须同改本表）；
 *   ④ 真跑的 `tests/integration/*.mjs` 集合与登记值**双向相等**（删一条、加一条都红）；
 *   ⑤ 每个被点名的脚本在磁盘上真实存在；
 *   ⑥ 每个真库臂 step 必须带 URL 型 env（`*_TEST_URL` / `DATABASE_TEST_URL` / `PGDATABASE`）——
 *      否则「跑起来了但连的是哪个库」不可审计；
 *   ⑦ 禁止 `continue-on-error: true`、`|| true`、`--allow-skip`、`GY_ALLOW_SKIP`、`secrets.*`；
 *   ⑧ 5 份合计的脚本集合与登记值双向相等（跨文件删 step 也红）；
 *   ⑨ 覆盖面自证：仓库里凡是 `image: postgres*` 的 workflow，要么在本文件登记，要么登记在
 *      `COVERED_ELSEWHERE` 里并指明覆盖它的测试文件真实存在 —— 新增一份真库 workflow 逃不掉。
 *
 * 纪律：判据只在「新增违规」时才红；本文件不碰 `.github/workflows/**` 之外的任何东西。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');

/** 本文件逐份守卫的 5 份 workflow（值全部按当前树实测登记，不是愿望）。 */
export const REAL_PG_WORKFLOWS = Object.freeze([
  Object.freeze({
    file: 'catalog-postgres.yml',
    job: 'catalog-pg',
    image: 'postgres:17.11',
    scripts: Object.freeze(['catalog-pg.mjs']),
    note: '目录域真库臂',
  }),
  Object.freeze({
    file: 'source-lifecycle-postgres.yml',
    job: 'lifecycle-pg',
    image: 'postgres:17.11',
    scripts: Object.freeze(['source-lifecycle-pg.mjs']),
    note: '来源生命周期真库臂',
  }),
  Object.freeze({
    file: 'staging-intake-postgres.yml',
    job: 'intake-pg',
    image: 'postgres:17.11',
    scripts: Object.freeze(['staging-intake-pg.mjs']),
    note: '暂存入库真库臂',
  }),
  Object.freeze({
    file: 'workbook-staging.yml',
    job: 'staging-pg17',
    image: 'postgres:17',
    scripts: Object.freeze(['workbook-staging-pg.mjs']),
    note: '工作簿暂存真库臂（镜像按现状登记 postgres:17，升级需同改本表与 workflow）',
  }),
  Object.freeze({
    file: 'consent-grant-postgres.yml',
    job: 'consent-grant-pg',
    image: 'postgres:17.11',
    scripts: Object.freeze([
      'consent-grant-pg.mjs',
      'egress-ledger-pg.mjs',
      'egress-object-key-pg.mjs',
      'egress-revoke-race-pg.mjs',
    ]),
    note: '同意授权 + 外发账本三段 + 撤回竞态（4 条臂靠 EGRESS_LEDGER_KEEP 串联状态）',
  }),
]);

/** 同样承载真库、但已由别的测试文件专门守卫的 workflow（新增一份真库 workflow 必须在这里登记或进上表）。 */
export const COVERED_ELSEWHERE = Object.freeze([
  Object.freeze({
    file: 'real-pg-integration.yml',
    covering: 'tests/unit/ci-real-pg-wiring.test.mjs',
    note: '判据⑦/⑧/⑨ 与受管清单、步序、双向相等都在那里',
  }),
  Object.freeze({
    file: 'auth-privacy-postgres.yml',
    covering: 'tests/unit/auth-privacy-arm-isolation.test.mjs',
    note: 'step 数、不同库、反向控制',
  }),
  Object.freeze({
    file: 'deploy-sql-gate.yml',
    covering: 'tests/unit/deploy-sql-gate-probe.test.mjs',
    note: '出厂 SQL 门禁的探针与 42501 计数',
  }),
]);

const URL_ENV_PATTERN = /(_TEST_URL|DATABASE_TEST_URL|PGDATABASE)\b/;
const FORBIDDEN = Object.freeze([
  Object.freeze({ pattern: /continue-on-error:\s*true/, why: '`continue-on-error: true` 会把真库失败降级成绿' }),
  Object.freeze({ pattern: /\|\|\s*true\b/, why: '`|| true` 会吞掉非零退出（77/1 都变绿）' }),
  Object.freeze({ pattern: /--allow-skip\b/, why: '`--allow-skip` 是「77 → 0」的既成出口' }),
  Object.freeze({ pattern: /GY_ALLOW_SKIP/, why: '`GY_ALLOW_SKIP` 同上，属脚本自持开关' }),
  Object.freeze({ pattern: /\$\{\{\s*secrets\./, why: '这 5 份 workflow 只用合成口令，不该读 `secrets.*`' }),
]);

/** 去掉 `#` 注释行（判据必须看**有效内容**，不能被注释里的字样带偏）。 */
export function stripCommentLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** 抽出所有 `run:` 之后的有效命令行（`- run: x` 与 `run: |` 两种写法都覆盖）。 */
export function runCommandTexts(text) {
  const lines = stripCommentLines(text).split(/\r?\n/);
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inline = /^\s*-?\s*run:\s*(.+)$/.exec(line);
    if (inline !== null && inline[1].trim() !== '|' && inline[1].trim() !== '>') {
      commands.push(inline[1].trim());
      continue;
    }
    if (/^\s*-?\s*run:\s*[|>]\s*$/.test(line)) {
      const baseIndent = line.length - line.trimStart().length;
      const block = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const body = lines[cursor];
        if (body.trim() === '') continue;
        const indent = body.length - body.trimStart().length;
        if (indent <= baseIndent) break;
        block.push(body.trim());
      }
      commands.push(block.join(' && '));
      index += block.length;
    }
  }
  return commands;
}

/** 从 run 命令里抽出 `tests/integration/*.mjs`（不限于 `-pg` / `-e2e` 后缀，一律取全量）。 */
export function scriptsRunBy(text) {
  const named = new Set();
  for (const command of runCommandTexts(text)) {
    for (const match of command.matchAll(/tests\/integration\/([A-Za-z0-9._-]+\.mjs)/g)) named.add(match[1]);
  }
  return [...named].sort();
}

/**
 * 单份 workflow 的结构问题清单。返回空数组即通过；每条消息都要能直接指出「哪里不对、期望什么」。
 * `exists` 可注入，便于在内存里造「脚本不存在」的场景做判别力自证。
 */
export function structureProblems(spec, text, { exists = (relative) => existsSync(join(ROOT, relative)) } = {}) {
  const problems = [];
  const body = stripCommentLines(text);
  if (body.trim() === '') {
    problems.push(`${spec.file}：文件为空或整份被注释掉`);
    return problems;
  }

  // job 键只在 `jobs:` 之后取（`on.pull_request` / `on.push` 也是两空格缩进，不能混进来）。
  const jobsSection = body.slice(body.search(/^jobs:\s*$/m));
  const jobKeys = [...jobsSection.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((match) => match[1]);
  if (jobKeys.length !== 1) {
    problems.push(`${spec.file}：只应有一个 job，实测 ${jobKeys.length} 个（${jobKeys.join('、')}）`);
  }
  if (!jobKeys.includes(spec.job)) {
    problems.push(`${spec.file}：找不到登记的 job「${spec.job}」（实测 ${jobKeys.join('、') || '无'}）`);
  }
  if (!/runs-on:\s*ubuntu-/.test(body)) {
    problems.push(`${spec.file}：缺 \`runs-on: ubuntu-*\`（真库臂只在 Linux runner 上被验证过）`);
  }

  const timeout = /^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(body);
  if (timeout === null) {
    problems.push(`${spec.file}：缺 job 级 \`timeout-minutes\`（超时会把「没跑到」混成「job 超时」）`);
  } else {
    const minutes = Number(timeout[1]);
    if (!(minutes >= 1 && minutes <= 30)) {
      problems.push(`${spec.file}：\`timeout-minutes: ${minutes}\` 超出 1–30 的可审计范围`);
    }
  }

  const image = /image:\s*(\S+)/.exec(body);
  if (image === null) {
    problems.push(`${spec.file}：缺 \`services.postgres.image\``);
  } else if (image[1] !== spec.image) {
    problems.push(`${spec.file}：镜像登记为「${spec.image}」，实测「${image[1]}」（换版本必须同改本表）`);
  }

  const scripts = scriptsRunBy(text);
  const declared = [...spec.scripts].sort();
  const missing = declared.filter((script) => !scripts.includes(script));
  const extra = scripts.filter((script) => !declared.includes(script));
  if (missing.length > 0) problems.push(`${spec.file}：登记了但 workflow 没跑：${missing.join('、')}`);
  if (extra.length > 0) problems.push(`${spec.file}：workflow 跑了但没登记：${extra.join('、')}`);
  for (const script of scripts) {
    if (!exists(`tests/integration/${script}`)) problems.push(`${spec.file}：点名了不存在的脚本 tests/integration/${script}`);
  }

  // 每个真库臂 step 之后 10 行内必须有 env 且含 URL 型键 —— 否则「连的是哪个库」不可审计。
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*-\s*run:.*node\s+tests\/integration\//.test(lines[index])) continue;
    const script = /tests\/integration\/([A-Za-z0-9._-]+\.mjs)/.exec(lines[index])?.[1] ?? '(未知脚本)';
    const window = lines.slice(index, index + 10).join('\n');
    if (!/^\s+env:/m.test(window)) {
      problems.push(`${spec.file}：${script} 这条臂没有 \`env:\`（连哪个库不可审计）`);
    } else if (!URL_ENV_PATTERN.test(window)) {
      problems.push(
        `${spec.file}：${script} 的 \`env:\` 里没有 URL 型键（\`*_TEST_URL\` / \`DATABASE_TEST_URL\` / \`PGDATABASE\`）`,
      );
    }
  }

  for (const item of FORBIDDEN) {
    if (item.pattern.test(text)) problems.push(`${spec.file}：出现 ${item.why}`);
  }

  // 文件级不变量：consent-grant 的 4 条臂靠「账本脚本保夹具」串起来，删掉这个开关会让后继臂红。
  if (spec.file === 'consent-grant-postgres.yml' && !/EGRESS_LEDGER_KEEP:\s*'1'/.test(body)) {
    problems.push(`${spec.file}：缺 \`EGRESS_LEDGER_KEEP: '1'\`（账本三段串联的既定前提）`);
  }

  return problems;
}

function readWorkflow(file) {
  return readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
}

function allWorkflowFiles() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

for (const spec of REAL_PG_WORKFLOWS) {
  test(`结构守卫：${spec.file}（${spec.note}）`, () => {
    const text = readWorkflow(spec.file);
    assert.deepEqual(structureProblems(spec, text), [], `${spec.file} 的结构判据必须逐条通过`);
  });
}

test('跨文件：5 份 workflow 合计的真库脚本集合与登记值双向相等', () => {
  const union = new Set();
  for (const spec of REAL_PG_WORKFLOWS) {
    for (const script of scriptsRunBy(readWorkflow(spec.file))) union.add(script);
  }
  const declared = new Set();
  for (const spec of REAL_PG_WORKFLOWS) {
    for (const script of spec.scripts) {
      assert.equal(declared.has(script), false, `脚本 ${script} 在登记表里重复出现`);
      declared.add(script);
    }
  }
  const missing = [...declared].sort().filter((script) => !union.has(script));
  const extra = [...union].sort().filter((script) => !declared.has(script));
  assert.deepEqual(missing, [], `登记了但没有任何 workflow 真跑：${missing.join('、')}`);
  assert.deepEqual(extra, [], `有 workflow 真跑但没登记：${extra.join('、')}`);
  assert.equal(union.size, declared.size, '合计条数必须相等');
});

test('覆盖面自证：凡是 `image: postgres*` 的 workflow 都必须被登记守卫覆盖', () => {
  const coveredByThisFile = new Set(REAL_PG_WORKFLOWS.map((spec) => spec.file));
  const coveredElsewhere = new Map(COVERED_ELSEWHERE.map((entry) => [entry.file, entry]));
  const withPostgres = allWorkflowFiles().filter((file) => /image:\s*postgres/.test(readWorkflow(file)));
  const unguarded = withPostgres.filter((file) => !coveredByThisFile.has(file) && !coveredElsewhere.has(file));
  assert.deepEqual(
    unguarded,
    [],
    `这些 workflow 跑着 postgres 却没有任何结构守卫：${unguarded.join('、')}。要么登记进 REAL_PG_WORKFLOWS，要么进 COVERED_ELSEWHERE 并指明覆盖它的测试。`,
  );
  for (const entry of COVERED_ELSEWHERE) {
    assert.ok(existsSync(join(ROOT, entry.covering)), `${entry.file} 声称由 ${entry.covering} 守卫，但该文件不存在`);
  }
  const stale = COVERED_ELSEWHERE.filter((entry) => !withPostgres.includes(entry.file)).map((entry) => entry.file);
  assert.deepEqual(stale, [], `这些条目已不再跑 postgres，登记该删：${stale.join('、')}`);
});

test('判别力自证：删一条臂的 step／去掉 timeout／加 `|| true`／点名幽灵脚本，判据必须变红', () => {
  const catalog = REAL_PG_WORKFLOWS.find((spec) => spec.file === 'catalog-postgres.yml');
  const text = readWorkflow(catalog.file);

  const withoutArm = text.replace('      - run: node tests/integration/catalog-pg.mjs\n', '');
  assert.notEqual(withoutArm, text, '自证前提：删臂的替换必须真的改动了文本');
  assert.ok(
    structureProblems(catalog, withoutArm).some((problem) => problem.includes('登记了但 workflow 没跑')),
    '删掉承载真库臂的 step 必须报「登记了但 workflow 没跑」',
  );

  const withoutTimeout = text.replace(/^ {4}timeout-minutes:.*\n/m, '');
  assert.notEqual(withoutTimeout, text, '自证前提：timeout 行必须真实存在（否则这条断言测的是空替换）');
  assert.ok(
    structureProblems(catalog, withoutTimeout).some((problem) => problem.includes('timeout-minutes')),
    '去掉 job 级 timeout 必须报出来',
  );

  const downgraded = text.replace(
    '      - run: node tests/integration/catalog-pg.mjs',
    '      - run: node tests/integration/catalog-pg.mjs || true',
  );
  assert.ok(
    structureProblems(catalog, downgraded).some((problem) => problem.includes('|| true')),
    '`|| true` 必须被禁止项抓住',
  );

  const ghostScript = text.replace('catalog-pg.mjs', 'catalog-pg-ghost.mjs');
  assert.ok(
    structureProblems(catalog, ghostScript).some((problem) => problem.includes('不存在的脚本')),
    '点名不存在的脚本必须红',
  );

  // 显式记录「本判据不管什么」：改库名/口令不在结构面，由臂自己的硬钉库名负责。
  const renamedDb = text.replace('gengyun_catalog_test', 'gengyun_catalog_test_renamed');
  assert.deepEqual(structureProblems(catalog, renamedDb), [], '改库名不在本判据面内（臂自己硬钉库名）');
});
