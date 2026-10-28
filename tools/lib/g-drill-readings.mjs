#!/usr/bin/env node
/**
 * G 片（GY-R68-G）· 「全量本地演练」的**纯逻辑层**：演练计划表、日志 → 读数解析、
 * 标记块渲染 / 解析 / 整块逐行比对（规范化后）、反空转下界、出处回溯（判据 3 两个方向）。
 *
 * 为什么要有这一层：证据页上每一个「可复算」读数，都必须在 `--check` 时**从树现场重算**
 * （fs 遍历 / `package.json` 解析 / workflow 文本扫描 / 真跑闸门）。期望值不许来自任何已提交的
 * JSON，也不许来自文档自身——否则「文档说 15，代码也算出 15」只是同义反复，文档腐烂时照样绿。
 *
 * ## 两类读数，**别混**
 *
 * 1. **可复算类**（本文件 `computeTreeReadings()` / `readingsOf()`）：
 *    文件数、glob 数、脚本清单、workflow / job 数、真库臂清单……`--check` 每次重算并逐键比对。
 *    这类读数**不存进 `readings.json`**，也没有第二份副本——树就是唯一真源。
 * 2. **一次性实测类**（`rows`：单测通过数、耗时、真跑臂的退出码）：
 *    页面只存「当时值 + sha + 主机 + 时刻」。`--check` 只校**形状与算术自洽**
 *    （`tests == pass + fail + skipped + todo`、sha 是 40 位 hex 且是 HEAD 的祖先、主机与 ISO 时刻非空），
 *    不假装能复算——日志留在 `$env:TEMP`、不入库，仓内没有第二份权威副本可比。
 *
 * ## 标记块
 *
 * `<!-- G-DRILL:BEGIN -->` … `<!-- G-DRILL:END -->` 之间**整块**由 `renderDrillBlock()` 生成：
 * 块内任何手写散文都会被 `--update` 抹掉、并被 `--check` 判红。散文只能写在块外。
 *
 * ⛔ 本文件不 spawn 任何进程（真跑在执行器 `tools/collect-g-drill.mjs`）；`--live` 由 CLI 调执行器。
 * ⛔ 本文件**不复制**真库臂的读数基线（`tests/unit/ci-real-pg-readings-gates.test.mjs` 里的
 *    `READING_GATE_BASELINES` 是唯一权威）；这里只**读它的臂清单**，用来断言「表里每条臂都出现在
 *    演练清单里（跑或逐条写明未跑原因）」。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 标记块起止行。 */
export const DOC_BEGIN = '<!-- G-DRILL:BEGIN -->';
export const DOC_END = '<!-- G-DRILL:END -->';

/** 证据页（仓内相对路径，一律正斜杠——⛔ 不要用 `path.join` 拼它，Windows 会拼成反斜杠）。 */
export const DOC_PATH = 'docs/verification/gy-r69-drill-full-20261028.md';

/** 真库臂闸门守卫单测：本文件**只读**它的 `script:` 行，不复制、不改写它的基线（§6 硬性禁止）。 */
export const REAL_PG_GATE_TEST = 'tests/unit/ci-real-pg-readings-gates.test.mjs';

/** `test:unit` 的五条 glob（与 `package.json` 的 `test:unit` 逐条对应）。 */
export const UNIT_GLOBS = Object.freeze([
  'tests/unit/*.test.mjs',
  'tests/privacy/*.test.mjs',
  'tests/media/*.test.mjs',
  'tests/reference/*.test.mjs',
  'tests/moderation/*.test.mjs',
]);

/** `test:unit` 实测跑到的五个目录（用于「分文件数之和 == 总数」这条算术）。 */
export const UNIT_GLOB_DIRS = Object.freeze(['tests/unit', 'tests/privacy', 'tests/media', 'tests/reference', 'tests/moderation']);

/**
 * 反空转**下界**：一律 `>=`，不用 `==`——在飞 PR 会往仓里加页、加测试、加 workflow，
 * 用等号会逼着每个 PR 都来改这里（而「改下界」正是把闸门放空的那条路）。
 *
 * 取值的口径：`node tools/verify-g-drill-readings.mjs --check` 在**本片 HEAD 上**的实测读数
 * （workflow 15 / job 25 / 演练命令 21 / `tests/` 下递归的 `*.test.mjs` 491 / `docs/verification/*.md` 298 /
 * 真库臂 13），再各留一点余量。⛔ 数字口径以 `--check` 自报的那一行为准：`--check` 打印「jobs N」，
 * 这里的 `workflowJobs` 就必须是 N（本片两个提交上都是 25；此前写 28、演练命令写 22 是 `readings-a.json`
 * 那版 22 条旧清单的残留，已按实测改正）。
 * 下界**只许上调**；确需下调必须在 PR 里贴出实测读数与原因。
 *
 * `workflowJobs`（25）与 `realPgArms`（13）是**故意零余量**：多一个不破，少一个立刻红。
 * 这两个数各自对应一条「静默空转」的风险面（job 数塌了 / 臂清单解析不出来），宁可偶尔误红也不放过；
 * 若要给它们留余量，先想清楚余的是什么（见证据页 §6「已知限制」）。
 */
export const DEFAULT_FLOORS = Object.freeze({
  workflows: 15,
  workflowJobs: 25,
  drillCommands: 20,
  allTestFiles: 490,
  verificationDocs: 297,
  realPgArms: 13,
});

/**
 * 「本机跑不了」的原因白名单（判据 8）：原因非空**且**含其中之一才算说明了为什么。
 * 白名单是**封闭**的：写「暂时不方便」这类话不通过——那不是原因，是没说。
 */
export const REASON_WHITELIST = Object.freeze(['docker', '网络', 'SDK', '未安装', 'WSL', '容器', '端口', '凭据', '供应商', 'strip-types']);

/** 章节标题（解析标记块时按它切换当前小节）。 */
export const SECTION_TREE = '#### 可复算读数（`--check` 每次从树现场重算）';
export const SECTION_ONESHOT = '#### 一次性实测（不可复算：只存当时值 + sha + 主机 + 时刻）';
export const SECTION_NOTES = '#### 未跑（本机跑不了）与不在演练范围（原因）';

/** 参数错 / 结构错时抛这个（CLI 会把它降级成 exit 1 的一行报错）。 */
export class GDrillError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GDrillError';
  }
}

/**
 * 本机自起 PG 集群的连接串前缀：三个真库臂各自在 URL 路径里写自己的库名。
 * 集群怎么起见证据页「方法」一节（`initdb` + `pg_ctl`，端口 55432，日志留 `$env:TEMP`）。
 */
export const PG_DRILL_BASE_URL = 'postgres://gy_drill:gy_drill@127.0.0.1:55432';

/**
 * 演练计划：**每条命令都是本机真跑过的**，顺序即页面顺序。
 *
 * `kind` 决定读数怎么从日志里抽：
 *   · `tap`  —— `node --test` 系：抽 TAP 汇总行（`# tests N` / `# pass N` / `# fail N` / `# skipped N` / `# todo N`）；
 *   · `gate` —— 闸门 CLI：只有退出码与耗时（它打的是人读表，不保证有稳定读数行）；
 *   · `pg`   —— 自起 PG 集群的真库臂：`READINGS=` 或 `[ALL PASS]` 或退出码。
 *
 * ⛔ 加命令就等于加演练：`drillCommands` 读数与下界 20 会一起跟着变。
 * ⛔ 每条命令的脚本路径都必须能在 `package.json` 的 `scripts` 值 / `.github/workflows/**` 文本 /
 *    `tests/failmatrix/run.mjs` 里找到出处（判据 3 正向）；找不到 ⇒ 红，这正是「采集注水」的红线。
 */
export const DRILL_PLAN = Object.freeze([
  {
    id: 'unit',
    group: 'unit',
    kind: 'tap',
    command: 'npm run test:unit',
    why: '五条 glob 的全量单测（本片的核心读数来源）',
  },
  {
    id: 'unit-ui-states',
    group: 'unit',
    kind: 'tap',
    command: 'node --test tests/ui-unified-states.test.mjs',
    why: '不在五条 glob 里的单测（仓根 `tests/*.test.mjs`），CI 单独点名跑',
  },
  {
    id: 'unit-demo-ui',
    group: 'unit',
    kind: 'tap',
    command: 'node --test tests/demo-ui-components.test.mjs',
    why: '同上，Demo 组件单测',
  },
  {
    id: 'lint',
    group: 'static',
    kind: 'gate',
    command: 'npm run lint',
    why: '工作区 lint（CI `static-check` job）',
  },
  {
    id: 'docs-development',
    group: 'static',
    kind: 'gate',
    command: 'node tools/run-python.mjs tools/validate_development_docs.py',
    why: '文档链接与结构闸门（CI `docs` job）',
  },
  {
    id: 'contracts-validate',
    group: 'static',
    kind: 'gate',
    command: 'node tools/run-python.mjs tools/validate_contracts.py',
    why: '契约校验（CI `docs` / `development-docs` job）',
  },
  {
    id: 'contracts-test',
    group: 'static',
    kind: 'gate',
    command: 'node tools/run-python.mjs tools/test_contracts.py',
    why: '契约自测（CI `docs` / `development-docs` job）',
  },
  {
    id: 'research-records',
    group: 'static',
    kind: 'gate',
    command: 'node tools/verify-research-records.mjs',
    why: '资料来源记录闸门（CI `docs` job）',
  },
  {
    id: 'contract-status',
    group: 'static',
    kind: 'gate',
    command: 'node tools/verify-contract-status.mjs',
    why: '契约台账锚点闸门（CI `engineering-shell.yml`）',
  },
  {
    id: 'doc-anchors',
    group: 'static',
    kind: 'gate',
    command: 'node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs',
    why: '文档符号锚点闸门（CI `engineering-shell.yml` 用的正是这条参数）',
  },
  {
    id: 'capability-map',
    group: 'static',
    kind: 'gate',
    command: 'node tools/verify-admin-capability-map.mjs --check',
    why: '后台能力图闸门（`package.json` 的 `verify:capability-map`）',
  },
  {
    id: 'purge-schedule',
    group: 'static',
    kind: 'gate',
    command: 'node tools/verify-purge-schedule.mjs',
    why: '保留期调度层闸门（`package.json` 的 `verify:purge-schedule`）',
  },
  {
    id: 'migrations-unique',
    group: 'static',
    kind: 'gate',
    command: 'node tools/verify-migrations-unique.mjs --annotations',
    why: '迁移号唯一性（CI `migrations-guard.yml`）',
  },
  {
    id: 'openapi-parity',
    group: 'static',
    kind: 'gate',
    command: 'node tools/openapi-route-parity.mjs',
    why: '路由 / OpenAPI 双向对账（`package.json` 的 `verify:parity`）',
  },
  {
    id: 'suite-contract',
    group: 'suite',
    kind: 'tap',
    command: 'npm run test:contract',
    why: '契约单测（CI `contract-tests` job）',
  },
  {
    id: 'suite-evaluation',
    group: 'suite',
    kind: 'tap',
    command: 'npm run test:evaluation',
    why: '评估链单测（CI `evaluation-tests` job）',
  },
  {
    id: 'suite-http',
    group: 'suite',
    kind: 'gate',
    command: 'npm run test:integration:http',
    why: '14 条回环 HTTP 集成脚本（CI `integration-http` job）',
  },
  {
    id: 'suite-failmatrix',
    group: 'suite',
    kind: 'gate',
    command: 'npm run test:failmatrix -- --json={logDir}\\failmatrix.json',
    why: '失败回退矩阵（CI `failmatrix.yml`；`{logDir}` 由执行器换成 `$env:TEMP\\gy-g-drill\\<sha>`，日志不入库）',
  },
  {
    id: 'pg-catalog',
    group: 'pg',
    kind: 'pg',
    command: 'node tests/integration/catalog-pg.mjs',
    env: { DATABASE_TEST_URL: `${PG_DRILL_BASE_URL}/gengyun_catalog_test` },
    why: '真库臂 1/3：连本机自起集群（证明 `GY_PG_BIN` 这条本机路径通）',
  },
  {
    id: 'pg-retention-purge',
    group: 'pg',
    kind: 'pg',
    command: 'node tests/integration/retention-purge-pg.mjs',
    env: { GY_R34_PG_ROOT: '{pgRoot}' },
    why: '真库臂 2/3：到期清除执行者（自己 `initdb` 起临时集群；`{pgRoot}` 见证据页「方法」）',
  },
  {
    id: 'pg-admin-audit-logs',
    group: 'pg',
    kind: 'pg',
    command: 'node tests/integration/admin-audit-logs-pg.mjs',
    env: { GY_R34_PG_ROOT: '{pgRoot}' },
    why: '真库臂 3/3：后台审计读面（同上，自己 `initdb` 起临时集群）',
  },
]);

/**
 * `test:mini` 的真实原因单独写成常量：它要的是微信开发者工具，不是 PyPI 上的东西。
 * （写在 `SCOPE_NOTES` 之前——顶层 `const` 有 TDZ，后置引用会在模块初始化时炸。）
 */
const TEST_MINI_REASON = '微信开发者工具 SDK 未安装（本机没有该 CLI，`check-wechat-project.mjs` 之后那条 `node --test` 无从跑起）';

/**
 * `validate_openapi_standard.py` 的真实处境（本机跑不了，且**它本身就不是 CI 闸门**）：
 * `--schema` 必填且要的是官方 OAS 3.1 规范文件，脚本头注释明写「不做下载/安装」；
 * 仓库里也没有随附该规范文件，且本机没有 `jsonschema`。
 * 另外它只出现在 `development-docs.yml` 的 `paths:` 里，任何 workflow 都没有对应的 `run:`。
 */
const OPENAPI_STANDARD_REASON =
  '需网络下载官方 OAS 3.1 规范文件（`--schema` 必填，脚本明示自己不做下载/安装），且本机未安装 jsonschema；'
  + '它也只出现在 `development-docs.yml` 的 `paths:` 里，任何 workflow 都没有它的 `run:` 步骤'
  + ' ⇒ **CI 里没有等价的 OAS 3.1 元模式校验**（CI 跑的 `validate_contracts.py` 只做「自仓 openapi 的版本号串 == 3.1.1」这一条自检，不等于元模式校验；这是既有缺口，本片不改）';

/** 非真跑的真库臂（`READING_GATE_BASELINES` 里除演练三条之外的臂）的未跑原因。 */
export const PG_ARM_NOT_RUN_REASON =
  '本片按 §4 只真跑三条自起集群臂；该臂在 CI 里挂 `services: postgres` 容器（库名与连接串由 workflow 注入），本机未起该容器';

/**
 * 「不在演练范围」的 `verify:*` / `test:*` 脚本：判据 3 要求 `package.json` 里每个
 * `verify:*` / `test:*` 要么出现在块里，要么**显式**标注不在范围并给出原因。
 *
 * 三类原因，别混：
 *   · `covered` —— 它的内容已被清单里某几条逐条覆盖（重复跑不增读数）；
 *   · `未跑`    —— 本机跑不了，原因必须落在 `REASON_WHITELIST` 上；
 *   · `不在演练范围` —— 本片的口径决定（例如只真跑三条自起集群臂）。
 */
export const SCOPE_NOTES = Object.freeze([
  {
    script: 'test:reference',
    marker: '不在演练范围',
    reason: '它的 glob（`tests/reference/*.test.mjs`）已被清单 #1 `npm run test:unit` 的第 4 条 glob 覆盖，单跑一遍不增读数',
  },
  {
    script: 'test:docs',
    marker: '不在演练范围',
    reason: '它的两条子命令已逐条在清单里（`validate_development_docs.py` / `verify-research-records.mjs`）',
  },
  {
    script: 'verify:anchors',
    marker: '不在演练范围',
    reason: '它的两条子命令已逐条在清单里（`verify-contract-status.mjs` / `verify-doc-anchors.mjs --strict --symbol=strict --scan docs`）',
  },
  {
    script: 'verify:parity',
    marker: '不在演练范围',
    reason: '它全部内容就是清单里的 `node tools/openapi-route-parity.mjs`',
  },
  {
    script: 'verify:capability-map',
    marker: '不在演练范围',
    reason: '它全部内容就是清单里的 `node tools/verify-admin-capability-map.mjs --check`',
  },
  {
    script: 'verify:purge-schedule',
    marker: '不在演练范围',
    reason: '它全部内容就是清单里的 `node tools/verify-purge-schedule.mjs`',
  },
  {
    entry: 'node tools/run-python.mjs tools/validate_openapi_standard.py',
    marker: '未跑',
    reason: OPENAPI_STANDARD_REASON,
  },
  {
    script: 'test:mini',
    marker: '未跑',
    reason: TEST_MINI_REASON,
  },
  {
    script: 'test:integration:recognition-chain-pg',
    marker: '未跑',
    reason: '网络与凭据都不在本机：该臂打真实供应商链路，CI 外一律禁用真实外部调用',
  },
  {
    script: 'test:integration:conversations-pg',
    marker: '未跑',
    reason: 'docker services 容器形态的 PG：库名与连接串由 workflow 的 `psql -c CREATE DATABASE` 注入，本机只有自起集群',
  },
  {
    script: 'test:integration:media-persistence-pg',
    marker: '未跑',
    reason: '同上（容器形态 PG），且需要 `--experimental-strip-types` 的独立运行时，本片未验证该组合',
  },
  {
    script: 'test:integration:backup-copies-purge-pg',
    marker: '未跑',
    reason: '同上（容器形态 PG，库名 `gengyun_*_test` 由 workflow 建）',
  },
  {
    script: 'test:integration:online-purge-pg',
    marker: '未跑',
    reason: '同上（容器形态 PG，库名由 workflow 建）',
  },
]);

// ─────────────────────────────────────────────────────────────────────────────
// 树 → 可复算读数
// ─────────────────────────────────────────────────────────────────────────────

/** 读文件；读不到返回 `null`（调用方自己决定是红还是跳过）。 */
function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 数一个「目录 + `*.ext`」形状的 glob（本仓用到的 glob 全是这一种，不需要通用 glob 引擎）。
 * ⛔ 只用 `readdirSync` 单层：这些 glob 都是单层通配，递归会把 `node_modules` 拖进来。
 */
export function countGlobFiles(root, glob) {
  const matched = /^(.*)\/\*\.([A-Za-z0-9.]+)$/.exec(glob);
  if (matched === null) throw new GDrillError(`不认识的 glob 形状：${glob}（本仓只用「目录/*.ext」）`);
  const dir = join(root, matched[1]);
  const ext = `.${matched[2]}`;
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { glob, dir: matched[1], files: [] };
  }
  const files = names
    .filter((entry) => entry.isFile() && entry.name.endsWith(ext))
    .map((entry) => `${matched[1]}/${entry.name}`)
    .sort();
  return { glob, dir: matched[1], files };
}

/** 递归数 `*.test.mjs`（跳过 `node_modules` 与 `.git`）。 */
export function countTestFiles(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...countTestFiles(full, base));
    } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      out.push(full);
    }
  }
  return out;
}

/** `jobs:` 段之下两空格缩进的 job 键（与 `tests/unit/ci-real-pg-readings-gates.test.mjs` 同一套缩进解析）。 */
export function declaredJobKeys(rawText) {
  const lines = String(rawText ?? '').split(/\r?\n/).map((line) => (/^\s*#/.test(line) ? '' : line));
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt < 0) return [];
  const keys = [];
  for (const line of lines.slice(jobsAt + 1)) {
    const matched = /^ {2}(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+)):\s*(?:#.*)?$/.exec(line);
    if (matched !== null) keys.push(matched[1] || matched[2] || matched[3]);
  }
  return keys;
}

/** `package.json` 的 `scripts`（读不到就空对象；解析失败抛错——那是结构问题，不该静默）。 */
export function readScripts(root) {
  const text = readIfExists(join(root, 'package.json'));
  if (text === null) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (failure) {
    throw new GDrillError(`package.json 不是合法 JSON：${String(failure.message ?? failure)}`);
  }
  return parsed.scripts ?? {};
}

/**
 * 从真库臂闸门守卫单测里读**臂清单**（`script: 'tests/integration/*.mjs'` 那几行）。
 * ⛔ 只读清单，不读 `baseline` / `counter`：那是那份单测唯一的权威，本片不复制。
 */
export function realPgArms(root) {
  const text = readIfExists(join(root, REAL_PG_GATE_TEST));
  if (text === null) return [];
  const arms = [];
  for (const matched of text.matchAll(/script: '(tests\/integration\/[^']+\.mjs)'/g)) {
    if (!arms.includes(matched[1])) arms.push(matched[1]);
  }
  return arms;
}

/** 演练清单里的全部命令（含未跑条目的 `node <arm>` 形态），用来核真库臂覆盖面。 */
export function plannedCommands(plan = DRILL_PLAN) {
  return plan.map((entry) => entry.command);
}

/**
 * **从树现场重算**全部可复算读数。
 *
 * 这是本片唯一的「期望值来源」：`--check` 拿它与文档块逐键比对，
 * 不从任何已提交 JSON、也不从文档自身取数。
 */
export function computeTreeReadings(root) {
  const workflowsDir = join(root, '.github', 'workflows');
  let workflowFiles = [];
  try {
    workflowFiles = readdirSync(workflowsDir)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort();
  } catch {
    workflowFiles = [];
  }
  const jobDetails = workflowFiles.map((name) => ({
    name,
    jobs: declaredJobKeys(readIfExists(join(workflowsDir, name))),
  }));
  const workflowJobs = jobDetails.reduce((sum, item) => sum + item.jobs.length, 0);

  const globs = UNIT_GLOBS.map((glob) => countGlobFiles(root, glob));
  const totalTestFiles = globs.reduce((sum, item) => sum + item.files.length, 0);
  const union = new Set(globs.flatMap((item) => item.files));

  const allTestFiles = countTestFiles(join(root, 'tests')).length;

  let verificationDocs = 0;
  try {
    verificationDocs = readdirSync(join(root, 'docs', 'verification')).filter((name) => name.endsWith('.md')).length;
  } catch {
    verificationDocs = 0;
  }

  const scripts = readScripts(root);
  const scriptNames = Object.keys(scripts).sort();
  const verifyTestScripts = scriptNames.filter((name) => /^(verify|test):/.test(name));

  const arms = realPgArms(root);
  const commands = plannedCommands();
  const drilledArms = arms.filter((arm) => commands.includes(`node ${arm}`));

  const warnings = [];
  for (const item of jobDetails) {
    if (item.jobs.length === 0) warnings.push(`workflow \`${item.name}\` 解析不出任何 job（没有 \`jobs:\` 段？）`);
  }
  if (workflowFiles.length === 0) warnings.push('`.github/workflows/` 里一个 workflow 都没读到');
  if (arms.length === 0) warnings.push(`读不到真库臂清单（${REAL_PG_GATE_TEST} 不存在？）`);

  return {
    root,
    workflows: workflowFiles.length,
    workflowFiles,
    jobDetails,
    workflowJobs,
    globs,
    totalTestFiles,
    unitGlobUnion: union.size,
    allTestFiles,
    verificationDocs,
    scripts,
    scriptNames,
    verifyTestScripts,
    arms,
    // 单独放一份数值：`DEFAULT_FLOORS` 的 `realPgArms` 下界要读它（`structureProblems` 按 `tree[key]` 取值），
    // 而 `arms` 是数组、`structureProblems` 认不出数组 ⇒ 没有这个字段时下界会退化成「读不到 realPgArms」。
    realPgArms: arms.length,
    drilledArms: drilledArms.length,
    warnings,
  };
}

/**
 * 可复算读数的**固定顺序 + 下界/关系说明**（渲染与比对共用这一份，防两处漂移）。
 * `relation` 是给人读的口径，不参与判定（判定看 `DEFAULT_FLOORS` 与各条判据）。
 */
export function readingsOf(tree) {
  const rows = [
    { key: 'workflows', value: tree.workflows, relation: '>= 15（`.github/workflows/` 下的 `*.yml` 与 `*.yaml` 文件数）' },
    { key: 'workflowJobs', value: tree.workflowJobs, relation: '>= 25（各 workflow `jobs:` 段两空格缩进键之和）' },
    { key: 'drillCommands', value: DRILL_PLAN.length, relation: '>= 20（演练计划里的命令条数）' },
    { key: 'allTestFiles', value: tree.allTestFiles, relation: '>= 490（`tests/**/*.test.mjs` 递归计数）' },
    { key: 'verificationDocs', value: tree.verificationDocs, relation: '>= 297（`docs/verification/*.md`）' },
    { key: 'totalTestFiles', value: tree.totalTestFiles, relation: '= 五条 `test:unit` glob 的分文件数之和' },
    { key: 'unitGlobUnion', value: tree.unitGlobUnion, relation: '必须等于 totalTestFiles（五条 glob 不许重叠）' },
    { key: 'packageScripts', value: tree.scriptNames.length, relation: '-（`package.json` 的 scripts 条数）' },
    { key: 'verifyTestScripts', value: tree.verifyTestScripts.length, relation: '每条都必须出现在本块里（跑或写明原因）' },
    { key: 'realPgArms', value: tree.realPgArms, relation: '>= 13（`ci-real-pg-readings-gates.test.mjs` 里的臂条数；只读，不复制基线）' },
    { key: 'drilledArms', value: tree.drilledArms, relation: '闸门表（`realPgArms`）里同时出现在演练清单中的条数；本片真跑的 3 条自起集群臂不在那张表里，故为 0（它们逐条写在下面「未跑」表之外的真实读数里）' },
  ];
  for (const item of tree.globs) {
    const dir = /^tests\/([a-z]+)\/\*\.test\.mjs$/.exec(item.glob);
    rows.push({
      key: `globFiles.${dir === null ? item.glob : dir[1]}`,
      value: item.files.length,
      relation: `-（\`${item.glob}\` 的分文件数）`,
    });
  }
  return rows;
}

/** 反空转：下界破了就返回问题列表（**每条都点名**是哪个读数、实测多少、下界多少）。 */
export function structureProblems(tree, floors = DEFAULT_FLOORS) {
  const problems = [];
  for (const [key, floor] of Object.entries(floors)) {
    const value = key === 'drillCommands' ? DRILL_PLAN.length : tree[key];
    if (typeof value !== 'number' || Number.isNaN(value)) {
      problems.push(`反空转下界破了：读不到 \`${key}\`（树里没有这个读数）⇒ 下界 ${floor} 无从判定`);
      continue;
    }
    if (value < floor) {
      problems.push(`反空转下界破了：${key} 实测 ${value} < 下界 ${floor}`);
    }
  }
  for (const warning of tree.warnings ?? []) problems.push(`树读数不全：${warning}`);
  return problems;
}

/** 同一条判据的可抛版本：单测/自证里用（CLI 用 `structureProblems()` 收集全部问题再一次报）。 */
export function assertNonVacuous(tree, floors = DEFAULT_FLOORS) {
  const problems = structureProblems(tree, floors);
  if (problems.length > 0) throw new GDrillError(problems.join('\n'));
  return tree;
}

// ─────────────────────────────────────────────────────────────────────────────
// 日志 → 读数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 抽单测汇总行。只认**行首**的两种汇总格式，且取最后一次出现
 * （嵌套 `node --test` 会打多份汇总，最后那份才是本次的）：
 *   - TAP reporter：`# tests 12` / `# pass 12` / `# fail 0` / `# skipped 0` / `# todo 0`
 *   - spec reporter（Node 20+ 默认，非 TTY 也常走这条）：`ℹ tests 12` / `ℹ pass 12` / `ℹ fail 0` / `ℹ skipped 0` / `ℹ todo 0`
 * 两种格式的**五项同名同义**，所以读数渲染成同一张表，判据 5 的算术也只需要一套。
 */
export function parseTapSummary(text) {
  const source = String(text ?? '');
  const read = (label) => {
    const pattern = new RegExp(`^(?:# |ℹ )${label} (\\d+(?:\\.\\d+)?)\\s*$`, 'gm');
    let last = null;
    for (const matched of source.matchAll(pattern)) last = matched[1];
    return last === null ? null : Number(last);
  };
  const tests = read('tests');
  if (tests === null) return null;
  return {
    tests,
    pass: read('pass'),
    fail: read('fail'),
    skipped: read('skipped'),
    todo: read('todo'),
    cancelled: read('cancelled'),
    durationMs: read('duration_ms'),
  };
}

/** 抽 `READINGS=<n>`（真库臂自报读数；取最后一次出现）。 */
export function parseReadingsLine(text) {
  let last = null;
  for (const matched of String(text ?? '').matchAll(/^READINGS=(\d+)\s*$/gm)) last = Number(matched[1]);
  return last;
}

/** 真库臂的收尾标记。 */
export function hasAllPassMarker(text) {
  return /\[ALL PASS\]/.test(String(text ?? ''));
}

/** 一份日志 → 「这次跑出了什么读数」。 */
export function summarizeLog(text) {
  return {
    tap: parseTapSummary(text),
    readings: parseReadingsLine(text),
    allPass: hasAllPassMarker(text),
  };
}

/**
 * 读数单元格的**唯一渲染口径**（`--update` 写它、`--check` 读它）。
 * 一次性读数的具体数字由这里定型；比对时不重算它们，只校形状与算术（见文件头第 2 类）。
 */
export function renderReadout(kind, summary, durationMs) {
  const millis = Number.isFinite(durationMs) ? Math.round(durationMs) : 0;
  if (kind === 'tap' && summary.tap !== null) {
    const { tests, pass, fail, skipped, todo } = summary.tap;
    return `tests ${tests} / pass ${pass} / fail ${fail} / skipped ${skipped} / todo ${todo} / ${millis}ms`;
  }
  if (summary.readings !== null && summary.readings !== undefined) return `READINGS=${summary.readings} / ${millis}ms`;
  if (summary.allPass) return `[ALL PASS] / ${millis}ms`;
  return `耗时 ${millis}ms`;
}

/** 读数单元格 → TAP 五项（不是 TAP 形状就返回 `null`）。 */
export function parseReadoutTap(readout) {
  const matched = /^tests (\d+) \/ pass (\d+) \/ fail (\d+) \/ skipped (\d+) \/ todo (\d+) \/ (\d+)ms$/.exec(String(readout ?? '').trim());
  if (matched === null) return null;
  return {
    tests: Number(matched[1]),
    pass: Number(matched[2]),
    fail: Number(matched[3]),
    skipped: Number(matched[4]),
    todo: Number(matched[5]),
    durationMs: Number(matched[6]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 标记块：渲染 / 解析 / 整块比对
// ─────────────────────────────────────────────────────────────────────────────

/** 一次性读数的行数据（`--update` 从 `readings.json` 造，`--check` 从文档块解析回来）。 */
export function makeRow({ command, exit, readout, sha, host, at }) {
  return { command, exit, readout, sha, host, at };
}

/** 未跑/不在范围的条目。 */
export function noteKeyFor(script) {
  return `npm run ${script}`;
}

/** 真库臂的未跑条目（除演练三条之外的每一条臂）。 */
export function armNotRunNotes(tree) {
  const commands = plannedCommands();
  return tree.arms
    .filter((arm) => !commands.includes(`node ${arm}`))
    .map((arm) => ({ entry: `node ${arm}`, marker: '未跑', reason: PG_ARM_NOT_RUN_REASON }));
}

/** 全部「未跑 / 不在演练范围」条目（渲染用；**完全由树 + 静态表推出**，块内不许手写）。 */
export function notesOf(tree) {
  const notes = SCOPE_NOTES.map((note) => ({
    entry: note.entry ?? noteKeyFor(note.script),
    marker: note.marker,
    reason: note.reason,
  }));
  return [...notes, ...armNotRunNotes(tree)];
}

/**
 * 渲染**整个**标记块（含起止行）。块内每一行都是生成物：
 * 块外可以写散文，块内手改一个字 `--check` 就红。
 */
export function renderDrillBlock({ tree, rows }) {
  const lines = [DOC_BEGIN];
  lines.push(SECTION_TREE);
  lines.push('');
  lines.push('| 键 | 读数 | 下界 / 关系 |');
  lines.push('| --- | --- | --- |');
  for (const row of readingsOf(tree)) {
    lines.push(`| ${row.key} | ${row.value} | ${mdCell(row.relation)} |`);
  }
  lines.push('');
  lines.push(SECTION_ONESHOT);
  lines.push('');
  lines.push('| # | 命令 | exit | 读数 | sha | 主机 | 时刻（ISO 8601） |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  rows.forEach((row, index) => {
    lines.push(
      `| ${index + 1} | \`${mdCell(row.command)}\` | ${row.exit} | ${mdCell(row.readout)} | \`@ ${row.sha}\` | 本机 ${mdCell(row.host)} | ${row.at} |`,
    );
  });
  lines.push('');
  lines.push(SECTION_NOTES);
  lines.push('');
  lines.push('| 条目 | 判定 |');
  lines.push('| --- | --- |');
  for (const note of notesOf(tree)) {
    lines.push(`| \`${mdCell(note.entry)}\` | ${note.marker}：${mdCell(note.reason)} |`);
  }
  lines.push(DOC_END);
  return lines.join('\n');
}

/**
 * Markdown 表格单元格转义：`|` 必须写成 `\|`，否则整行会被解析成多列，
 * `tools/validate_development_docs.py` 会直接报 `inconsistent table`（实测：`*.yml|yaml` 就踩了这一条）。
 */
export function mdCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|');
}

/** 把行尾统一成 LF、去掉每行尾空白（仓库 `*.md` 是 `text eol=lf`；CRLF 误检出不该算手改）。 */
export function normalizeDrillBlock(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/** 文档里的标记块行号（1 基，指向 `BEGIN` 与 `END` 那两行）。 */
export function markerLines(docText) {
  const lines = String(docText ?? '').split(/\r?\n/);
  const begins = [];
  const ends = [];
  lines.forEach((line, index) => {
    if (line.includes(DOC_BEGIN)) begins.push(index + 1);
    if (line.includes(DOC_END)) ends.push(index + 1);
  });
  return { begins, ends, lines };
}

/**
 * 解析文档里的标记块。**判据 1（标记块唯一）**在这里：
 * `BEGIN` / `END` 各恰一处，且 `BEGIN` 在 `END` 之前；缺 / 多都红并点名行号。
 */
export function parseDrillBlock(docText) {
  const { begins, ends, lines } = markerLines(docText);
  const problems = [];
  if (begins.length === 0) problems.push(`文档里没有 \`${DOC_BEGIN}\` ⇒ 标记块缺失，无从比对`);
  if (ends.length === 0) problems.push(`文档里没有 \`${DOC_END}\` ⇒ 标记块缺失，无从比对`);
  if (begins.length > 1) problems.push(`\`${DOC_BEGIN}\` 出现 ${begins.length} 处（第 ${begins.join(' / ')} 行）⇒ 必须恰好 1 处，否则比对哪一块都不对`);
  if (ends.length > 1) problems.push(`\`${DOC_END}\` 出现 ${ends.length} 处（第 ${ends.join(' / ')} 行）⇒ 必须恰好 1 处`);
  if (begins.length === 1 && ends.length === 1 && ends[0] < begins[0]) {
    problems.push(`\`${DOC_END}\`（第 ${ends[0]} 行）出现在 \`${DOC_BEGIN}\`（第 ${begins[0]} 行）之前 ⇒ 块是反的`);
  }
  if (problems.length > 0) return { block: '', startLine: 0, endLine: 0, problems, rows: [], notes: [], readings: new Map() };

  const startLine = begins[0];
  const endLine = ends[0];
  const block = normalizeDrillBlock(lines.slice(startLine - 1, endLine).join('\n'));
  return {
    block,
    startLine,
    endLine,
    problems,
    rows: parseRows(block),
    notes: parseNotes(block),
    readings: parseReadings(block),
  };
}

/** 按小节标题把块切成 `{tree, oneshot, notes}` 三段原始行。 */
function splitSections(block) {
  const sections = { tree: [], oneshot: [], notes: [], other: [] };
  let current = 'other';
  for (const line of String(block ?? '').split('\n')) {
    if (line.trim() === SECTION_TREE) current = 'tree';
    else if (line.trim() === SECTION_ONESHOT) current = 'oneshot';
    else if (line.trim() === SECTION_NOTES) current = 'notes';
    sections[current].push(line);
  }
  return sections;
}

/** markdown 表格行 → 单元格数组（不是表格行返回 `null`）。 */
function splitTableRow(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
  if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) return null;
  return cells;
}

/** 块内可复算表 → `Map(key, Number(value))`。 */
export function parseReadings(block) {
  const map = new Map();
  for (const line of splitSections(block).tree) {
    const cells = splitTableRow(line);
    if (cells === null || cells.length < 2) continue;
    if (/^\d+$/.test(cells[1])) map.set(cells[0], Number(cells[1]));
  }
  return map;
}

/** 块内一次性表 → 行数组（`sha` 去掉 `@ ` 前缀）。 */
export function parseRows(block) {
  const rows = [];
  for (const line of splitSections(block).oneshot) {
    const cells = splitTableRow(line);
    if (cells === null || cells.length < 7) continue;
    if (!/^\d+$/.test(cells[0])) continue;
    rows.push(
      makeRow({
        command: cells[1].replace(/^`|`$/g, ''),
        exit: Number(cells[2]),
        readout: cells[3],
        sha: cells[4].replace(/^`@\s*/, '').replace(/`$/, ''),
        host: cells[5].replace(/^本机\s*/, ''),
        at: cells[6],
      }),
    );
  }
  return rows;
}

/** 块内「未跑 / 不在演练范围」表 → 条目数组（`reason` 保留原文，空串也算一条，判据 8 负责红）。 */
export function parseNotes(block) {
  const notes = [];
  for (const line of splitSections(block).notes) {
    const cells = splitTableRow(line);
    if (cells === null || cells.length < 2) continue;
    const entry = cells[0].replace(/^`|`$/g, '');
    if (entry === '条目') continue; // 表头（`| 条目 | 判定 |`）不是一条未跑记录
    const verdict = cells[1];
    const matched = /^(未跑|不在演练范围)：([\s\S]*)$/.exec(verdict);
    notes.push({
      entry,
      marker: matched === null ? verdict : matched[1],
      reason: matched === null ? '' : matched[2].trim(),
      text: line.trim(),
    });
  }
  return notes;
}

/**
 * **判据 2**：整块逐行比对（规范化之后：CRLF→LF、去行尾空白、去尾部空行；不只比读数表）。
 * 返回 `null`（一致）或 `{ docLine, expectLine, docText, expectText, missing }`——
 * 报错文案由 `renderDifference()` 统一成「第一处差异：文档第 N 行 vs 重算第 M 行」。
 */
export function diffDrillBlock(docBlock, expectedBlock, startLine = 1) {
  const left = normalizeDrillBlock(docBlock).split('\n');
  const right = normalizeDrillBlock(expectedBlock).split('\n');
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === right[index]) continue;
    return {
      docLine: startLine + index,
      expectLine: index + 1,
      docText: left[index] ?? '',
      expectText: right[index] ?? '',
      missing: left[index] === undefined ? 'doc' : right[index] === undefined ? 'expected' : null,
    };
  }
  return null;
}

/** 「第一处差异」的标准文案（单测与 CLI 共用，省得两边措辞漂）。 */
export function renderDifference(difference) {
  if (difference === null) return null;
  const head = `第一处差异：文档第 ${difference.docLine} 行 vs 重算第 ${difference.expectLine} 行`;
  const tail = difference.missing === 'doc'
    ? `（文档缺这一行；重算是 \`${difference.expectText}\`）`
    : difference.missing === 'expected'
      ? `（重算里没有这一行；文档多写了 \`${difference.docText}\`）`
      : `\n  文档：\`${difference.docText}\`\n  重算：\`${difference.expectText}\``;
  return `${head}${tail}`;
}

/**
 * 判据 2 的**可抛入口**：单测里直接喂两段文本（`assert.equal(compareDrillBlock(...), null)`）。
 * ⚠ CLI 不调它——`checkDocument` 走的是 `diffDrillBlock()` + `renderDifference()`
 * （要拿到结构化差异才能点名行号）。两者判据相同，这里只是给单测省一层拆包。
 */
export function compareDrillBlock(docBlock, expectedBlock, startLine = 1) {
  return renderDifference(diffDrillBlock(docBlock, expectedBlock, startLine));
}

// ─────────────────────────────────────────────────────────────────────────────
// 判据 3：出处双向
// ─────────────────────────────────────────────────────────────────────────────

/** 命令里出现的「仓内脚本路径」记号（正斜杠；本仓的命令都长这样）。 */
export function pathTokens(command) {
  return String(command ?? '')
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ''))
    .filter((token) => /^(tests|tools|services|apps|packages|scripts)\/[A-Za-z0-9._/-]+\.(mjs|cjs|js|py|ts|json)$/.test(token));
}

/** 出处的三处来源：`package.json` 的 scripts 值、workflow 全文、failmatrix runner 全文。 */
export function collectSources(root) {
  const scripts = readScripts(root);
  const workflowsDir = join(root, '.github', 'workflows');
  const workflows = [];
  try {
    for (const name of readdirSync(workflowsDir).filter((item) => /\.ya?ml$/.test(item)).sort()) {
      workflows.push({ name, text: readIfExists(join(workflowsDir, name)) ?? '' });
    }
  } catch {
    // 没有 workflow 目录：出处只剩 scripts 与 failmatrix（判据 4 的下界会先红）。
  }
  const failmatrix = readIfExists(join(root, 'tests', 'failmatrix', 'run.mjs')) ?? '';
  return { scripts, workflows, failmatrix };
}

/** workflow 文本里提到某个记号的第一处（含它是 `run:` 行还是 `paths:` 声明）。 */
export function workflowMention(sources, token) {
  for (const workflow of sources.workflows) {
    const lines = workflow.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(token)) continue;
      const line = lines[index];
      const kind = /^\s*(?:- )?run:/.test(line)
        ? 'run: 文本'
        : /^\s*- ['"]/.test(line)
          ? 'paths 声明'
          : '其他文本';
      return { file: `.github/workflows/${workflow.name}`, line: index + 1, kind };
    }
  }
  return null;
}

/**
 * **判据 3 正向**：一条命令能否在仓内找到出处。
 *
 * 规则（不给「差不多的命令」留口子）：
 *   · `npm run <name>`：`<name>` 必须在 `package.json` 的 `scripts` 里；
 *   · 其余命令：**每一个**仓内脚本路径记号都必须真实存在，且出现在
 *     `scripts` 的值 / 某个 workflow 文件 / `tests/failmatrix/run.mjs` 里；
 *   · 一个记号都找不到（例如 `node -e "process.exit(0)"`）⇒ 红，文案固定含
 *     「不在 package.json/workflow 文本里」——采集注水就是这么被抓的。
 */
export function traceCommand(command, sources, root) {
  const tokens = String(command ?? '').trim().split(/\s+/);
  const sourcesFound = [];
  if (tokens[0] === 'npm' && tokens[1] === 'run') {
    const name = tokens[2];
    if (typeof sources.scripts[name] !== 'string') {
      return { ok: false, reason: `\`npm run ${name ?? ''}\` 不在 package.json/workflow 文本里（\`scripts\` 里没有这个名字）` };
    }
    return { ok: true, sources: [`package.json#scripts.${name}`] };
  }
  const paths = pathTokens(command);
  if (paths.length === 0) {
    return { ok: false, reason: `\`${command}\` 不在 package.json/workflow 文本里（命令里没有任何仓内脚本路径，无从对账）` };
  }
  for (const token of paths) {
    // 记号一律是 `/` 归一（见 `pathTokens()`），这里**按 `/` 切分再拼**：
    // 判定语义因此只由「`root` + 记号」决定，与运行平台的路径分隔符无关。
    // ⛔ 不要退回 `join(root, token)` 之外的隐式兜底（`process.cwd()` / `resolve(token)` 之类）：
    // `root` 必须由调用方显式传入，夹具与真仓才不会走上同一条隐式回退。
    if (!existsSync(join(root, ...String(token).split('/')))) {
      return { ok: false, reason: `\`${command}\` 点到的 \`${token}\` 不在仓库里（文件不存在）⇒ 不在 package.json/workflow 文本里` };
    }
    const scriptOwner = Object.entries(sources.scripts).find(([, value]) => typeof value === 'string' && value.includes(token));
    if (scriptOwner !== undefined) {
      sourcesFound.push(`package.json#scripts.${scriptOwner[0]}`);
      continue;
    }
    const mention = workflowMention(sources, token);
    if (mention !== null) {
      sourcesFound.push(`${mention.file}:${mention.line}（${mention.kind}）`);
      continue;
    }
    if (sources.failmatrix.includes(token)) {
      sourcesFound.push('tests/failmatrix/run.mjs');
      continue;
    }
    return { ok: false, reason: `\`${command}\` 里的 \`${token}\` 不在 package.json/workflow 文本里（也没有出现在 tests/failmatrix/run.mjs 里）` };
  }
  return { ok: true, sources: sourcesFound };
}

/**
 * **判据 3 反向**：`package.json` 里每个 `verify:*` / `test:*` 都必须出现在块里，
 * 或者被**显式**标注「不在演练范围：原因」/「未跑：原因」（原因非空）。
 *
 * `npm run <name>` 出现在块里就算「在块里」——跑的命令行与「为什么没跑」的行都长这样，
 * 区别看那一行有没有 `未跑：` / `不在演练范围：` 标记。
 */
export function coverageProblems(tree, block) {
  const lines = normalizeDrillBlock(block).split('\n');
  const plannedScripts = new Set(
    plannedCommands()
      .filter((command) => command.startsWith('npm run '))
      .map((command) => command.split(/\s+/)[2]),
  );
  const problems = [];
  for (const name of tree.verifyTestScripts) {
    const needle = `npm run ${name}`;
    const hits = lines.filter((line) => line.includes(needle));
    if (plannedScripts.has(name)) {
      // 它在演练计划里 ⇒ 有读数行就算数；但块里不能把这一行删掉（否则计划与页面不一致）。
      if (hits.length === 0) {
        problems.push(`\`${needle}\` 在演练计划里，但块里找不到这一行 ⇒ 计划与证据页必须逐条对上`);
      }
      continue;
    }
    if (hits.length === 0) {
      const value = tree.scripts[name] ?? '';
      const valueHits = lines.filter((line) => value !== '' && line.includes(value));
      if (valueHits.length === 0) {
        problems.push(
          `package.json 的 \`${name}\`（= \`${value}\`）既不在演练清单里、也没有标注「未跑：原因」或「不在演练范围：原因」`
            + ' ⇒ 判据 3 反向：漏登记的脚本可以悄悄退出扫描面',
        );
        continue;
      }
      continue;
    }
    if (hits.some((line) => /(未跑|不在演练范围)：\s*\S/.test(line))) continue;
    problems.push(`\`${needle}\` 出现在块里，但那一行没有「未跑：原因」/「不在演练范围：原因」⇒ 读者不知道它到底跑了没有`);
  }
  return problems;
}

/** 真库臂覆盖：`ci-real-pg-readings-gates.test.mjs` 里每条臂都必须出现在块里（跑或写明未跑原因）。 */
export function armCoverageProblems(tree, block) {
  const text = normalizeDrillBlock(block);
  const problems = [];
  // 空循环＝静默通过：「臂清单读成 0 条」时这一条什么都没说。这里显式红（判据 4 的
  // `realPgArms` 下界也兜同一件事，两处都留，是因为解析面失效的样子就是「看起来全绿」）。
  if (tree.arms.length === 0) {
    return [`从 \`${REAL_PG_GATE_TEST}\` 解析真库臂得到 0 条 ⇒ 臂清单的解析面可能已失效（判据 4 的 realPgArms 下界也应当红）`];
  }
  for (const arm of tree.arms) {
    const note = text.split('\n').find((line) => line.includes(`node ${arm}`) && /(未跑|不在演练范围)：\s*\S/.test(line));
    const ran = DRILL_PLAN.some((entry) => entry.command === `node ${arm}`);
    if (ran || note !== undefined) continue;
    problems.push(`真库臂 \`${arm}\` 既不在演练清单里、也没有「未跑：原因」⇒ 表里的臂必须逐条出现在演练清单里（不复制它的基线，只要求露面）`);
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// 判据 5 / 6 / 7 / 8：算术、一次性读数形状、别写「CI 已绿」、真空项
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **判据 5**：算术自洽。
 *   · 每条 TAP 行：`tests == pass + fail + skipped + todo`（`cancelled` 不参与，它不进这四项）；
 *   · `totalTestFiles == unitGlobUnion`（五条 glob 不许重叠、不许漏）；
 *   · 每条 `kind === 'tap'` 的命令都必须留下 TAP 汇总行（不许把读数行悄悄删成「耗时」）。
 */
export function arithmeticProblems(tree, rows) {
  const problems = [];
  if (tree.totalTestFiles !== tree.unitGlobUnion) {
    problems.push(
      `算术不自洽：totalTestFiles ${tree.totalTestFiles} ≠ unitGlobUnion ${tree.unitGlobUnion}`
        + '（五条 `test:unit` glob 有重叠或漏算）⇒ 分文件数之和不再等于总数',
    );
  }
  const byCommand = new Map(rows.map((row) => [row.command, row]));
  for (const entry of DRILL_PLAN) {
    const row = byCommand.get(entry.command);
    if (row === undefined) continue;
    const tap = parseReadoutTap(row.readout);
    if (entry.kind === 'tap' && tap === null) {
      problems.push(`算术不自洽：\`${entry.command}\` 是一次 TAP 命令，但读数格写的是 \`${row.readout}\`（缺 \`tests/pass/fail/skipped/todo\` 五项）`);
      continue;
    }
    if (tap === null) continue;
    const total = tap.pass + tap.fail + tap.skipped + tap.todo;
    if (tap.tests !== total) {
      problems.push(
        `算术不自洽：\`${entry.command}\` 写 tests ${tap.tests}，而 pass ${tap.pass} + fail ${tap.fail} + skipped ${tap.skipped} + todo ${tap.todo} = ${total}`,
      );
    }
  }
  return problems;
}

/**
 * **判据 6**：一次性读数三件套（`sha` 40 位 hex / `host` 非空 / ISO 时刻非空），
 * 且 `sha` 若能解析就**必须是 HEAD 的祖先**（不能拿别人的提交顶替）。
 *
 * `isAncestor(sha)` 由调用方注入（CLI 用 `git merge-base --is-ancestor`，返回
 * `true` / `false` / `null`＝无法判断）。
 */
export function oneShotProblems(rows, { isAncestor = () => null, runnable = DRILL_PLAN } = {}) {
  const problems = [];
  if (rows.length !== runnable.length) {
    problems.push(`一次性表有 ${rows.length} 行，演练计划有 ${runnable.length} 条命令 ⇒ 行数必须逐条相等（少一行就少一条读数）`);
  }
  rows.forEach((row, index) => {
    const expected = runnable[index];
    if (expected !== undefined && row.command !== expected.command) {
      problems.push(`第 ${index + 1} 行命令是 \`${row.command}\`，演练计划第 ${index + 1} 条是 \`${expected.command}\` ⇒ 顺序/命令必须与计划逐条相等`);
    }
    if (!/^[0-9a-f]{40}$/.test(row.sha)) {
      problems.push(`\`${row.command}\` 的 sha 是 \`${row.sha}\` ⇒ 必须是 40 位小写 hex`);
    } else {
      const verdict = isAncestor(row.sha);
      if (verdict === false) problems.push(`\`${row.command}\` 的 sha \`${row.sha}\` 不是 HEAD 的祖先 ⇒ 读数必须绑定本线提交`);
    }
    if (!Number.isInteger(row.exit) || row.exit < 0 || row.exit > 255) {
      problems.push(`\`${row.command}\` 的 exit 是 \`${row.exit}\` ⇒ 必须是 0..255 的整数`);
    }
    if (typeof row.host !== 'string' || row.host.trim() === '') {
      problems.push(`\`${row.command}\` 没有写 host ⇒ 一次性读数必须记清「跑在哪台机器上」`);
    }
    if (typeof row.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(row.at)) {
      problems.push(`\`${row.command}\` 的时刻 \`${row.at}\` 不是 ISO 8601 ⇒ 一次性读数必须带时刻`);
    }
  });
  return problems;
}

/**
 * **判据 7**：块内出现 `success` / `通过` 时，**同一行**必须带 `@ <40 位 sha>` 与「本机」字样。
 *
 * 依据 `docs/verification/how-to-read-ci-runs.md` §4/§5：CI 读数不入库、本机读数 ≠ `ubuntu-24.04`
 * 读数。想写「绿」，就必须写清是谁在哪个提交上跑出来的；否则那句话可以被读者当成 CI 结论。
 */
export function ciGreenProblems(block, startLine = 1) {
  const problems = [];
  normalizeDrillBlock(block)
    .split('\n')
    .forEach((line, index) => {
      if (!/success|通过/.test(line)) return;
      const hasSha = /@\s*[0-9a-f]{40}/.test(line);
      const hasLocal = line.includes('本机');
      if (hasSha && hasLocal) return;
      const missing = [!hasSha ? '`@ <40 位 sha>`' : null, !hasLocal ? '「本机」' : null].filter(Boolean).join(' 与 ');
      problems.push(`文档第 ${startLine + index} 行写了「绿」但没有${missing}：\`${line.trim()}\` ⇒ 不得写「CI 已绿 / 全部通过」这类无 SHA 的话`);
    });
  return problems;
}

/**
 * **判据 8**：真空项显式化。每条「本机跑不了」的条目必须写 `未跑：<原因>`，
 * 原因非空**且**落在 `REASON_WHITELIST`（或白名单键）上；`不在演练范围：` 同理必须给原因。
 */
export function vacuousProblems(notes) {
  const problems = [];
  for (const note of notes) {
    if (note.marker !== '未跑' && note.marker !== '不在演练范围') {
      problems.push(`\`${note.entry}\` 的判定是 \`${note.marker}\` ⇒ 只能是「未跑：原因」或「不在演练范围：原因」`);
      continue;
    }
    if (note.reason === '') {
      problems.push(`\`${note.entry}\` 写了「${note.marker}：」但原因空着 ⇒ 空原因等于没说`);
      continue;
    }
    if (note.marker === '未跑' && !REASON_WHITELIST.some((key) => note.reason.includes(key))) {
      problems.push(
        `\`${note.entry}\` 的未跑原因「${note.reason}」没有落在白名单（${REASON_WHITELIST.join(' / ')}）上`
          + ' ⇒ 读者无法判断这是环境差异还是漏跑',
      );
    }
  }
  return problems;
}

/**
 * 判据 3 反向的「读侧」：文档块里出现的每条命令都必须是**计划内的**或**带原因的未跑条目**。
 * （块里凭空多一条命令，既不在计划里也没有出处，同样要红。）
 */
export function rowCommandProblems(rows) {
  const problems = [];
  const planned = new Set(plannedCommands());
  for (const row of rows) {
    if (planned.has(row.command)) continue;
    problems.push(`块里第 ${rows.indexOf(row) + 1} 行命令 \`${row.command}\` 不在演练计划里 ⇒ 计划外的命令没有读数约定`);
  }
  return problems;
}

/** 判据 2 的「文档 vs 重算」单键比对（比整块比对更能点名是哪个读数漂了）。 */
export function readingsProblems(docReadings, tree) {
  const problems = [];
  const expected = readingsOf(tree);
  for (const row of expected) {
    if (!docReadings.has(row.key)) {
      problems.push(`${row.key}：文档里没有这个读数（重算 ${row.value}）`);
      continue;
    }
    const docValue = docReadings.get(row.key);
    if (docValue !== row.value) problems.push(`${row.key}：文档写 ${docValue}，重算 ${row.value}`);
  }
  const known = new Set(expected.map((row) => row.key));
  for (const key of docReadings.keys()) {
    if (!known.has(key)) problems.push(`${key}：文档里有、重算里没有 ⇒ 手写的读数不被认可`);
  }
  return problems;
}
