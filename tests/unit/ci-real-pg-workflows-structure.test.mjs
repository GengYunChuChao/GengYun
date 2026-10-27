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
 *   ⑩ 触发面（R68-D04）：每条已登记的臂，其 `on.<event>.paths`（**存在时**）必须覆盖该臂的
 *      **被测实现目录**；实现目录从数据里复算（口径见 `implementationPaths()` 的注释），
 *      ⛔ 不在这条判据里硬编码任何一份 yml 的清单。缺 `paths:` 的臂按「全量触发」处理 ——
 *      它天然覆盖实现目录，但**必须被记为「已检查过」**（见反空转用例）。
 *      这条判据是 **fail-closed** 的，五条「假绿出口」都堵掉（审查方 M6/M7/B1''/B1'''/B1'''' 实测过这些出口）：
 *        · `on.<event>.paths-ignore` 若**排除**到任一被测实现目录 ⇒ 红。被排除的实现目录等于
 *          这条臂对它永不触发，和「没写 paths」是相反的两件事，不能都当全量触发。
 *          存在 `paths-ignore` 但与被测目录无关 ⇒ 允许（例如只排除 `docs/**`）。
 *        · 覆盖与排除都按 **glob 常用子集**判（`**` 跨多层、`*` 不跨 `/`；见 `pathGlobToRegExp()`），
 *          不是字面前缀：`**\/db/**`、`services/api/src/**\/db/**` 一样算排除；
 *          `services/api/src/knowledge/**\/*`、`services/api/src/**\/knowledge/**` 一样算覆盖。
 *          而单星号 `services/api/src/*` **不算覆盖**：GitHub 的 `*` 不跨 `/`，匹配不到子目录里的
 *          文件，拿它当覆盖就是假绿；判红并提示改成 `/**`。
 *        · **未建模的写法一律拒绝**（`unmodeledGlobReason()` 的字符白名单）：`[d]b`、`{db,x}`、
 *          `+(db)`、`!` 负向、`\` 转义等 Actions/minimatch 扩展语法判红并给改写建议 ——
 *          「看不懂就当字面量 ⇒ 不匹配」正是「悄悄排掉实现目录还全绿」的形态。
 *        · **`on:` 段只按「书写形态白名单」判**（`triggerShapeProblems()`，第八轮架构调整）：
 *          判据⑩ 不解释 YAML 语义，只断言 `on:` 段每一行属于**六类允许形态**之一 —— ① 空行/纯注释行、
 *          ② 事件层裸键 `  <event>:`、③ `    <key>: <行内序列|引号标量|空|行尾注释>`、
 *          ④ 块序列条目 `      - <同行有值>`、⑤ 不含 `paths` 的事件 flow mapping、⑥ `inputs:`/`with:`
 *          之下的输入声明 —— 其余一律判红。于是 tag（`!!map`）、块序列把值写在下一行（行尾只有 `-`）、
 *          flow mapping 里藏 `paths-ignore`、整段 `on:` 写成 flow mapping、锚点/别名/合并键、
 *          带引号或冒号前有空格的键名，都在这一刀下变红并点名该行。宁可拒绝，也不让
 *          「看不见 = 没写 = 全量触发」蒙过去。行尾注释先剥掉再判（`paths-ignore:   # 说明` 的
 *          yaml 真值是 null，属合法写法）。新写法另开一片，不在本判据里放宽。
 *          `on:` 这一行本身只放行三种：块写法 `on:`、单个事件名（裸名或带引号 `on: push` / `on: "push"`）、
 *          行内事件列表（`on: [push, pull_request]`，元素可带引号、可混排）—— 这三种都藏不进任何
 *          `paths` / `paths-ignore` 过滤；`on: {…}`（flow mapping）能藏，继续判红，其余不认识
 *          的 `on:` 写法用另一句文案（「不认识的 `on:` 写法」）。
 *      **已知限制（判定面冻结）**：本判据只对**合法 YAML** 承诺。非法写法 —— 例如 `paths:` 既给了
 *      行内序列、下面又列块序列条目，或同一个键写两遍 —— 不保证判红，也不在判定面里；
 *      **非法 YAML 可能连形状都不报 ⇒ 绿不等于扫过**。要覆盖非法写法请另开一片，别在这里加特例。
 *      报错分三档，文案不混：**解析形态异常 / 解析形态不支持**（该行不属于上述允许形态）、
 *      **条目形状越界**（白名单外的 glob 写法）、**语义判定**（没覆盖 / 被排除）。
 *
 * 纪律：判据只在「新增违规」时才红；本文件不碰 `.github/workflows/**` 之外的任何东西。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

/** 去掉行尾注释（`#` 前必须是行首或空白）—— `paths-ignore:   # 说明` 的取值就是「空」。 */
function stripTrailingComment(line) {
  return line.replace(/(^|[ \t])#.*$/, '').replace(/\s+$/, '');
}

/**
 * 认「这一行是不是 paths / paths-ignore 键」—— **宽松**：允许键名带引号（`"paths":`）、允许
 * 冒号前有空格（`paths-ignore :`）。用于「先认键名、再认写法」：认出来但写法不是裸键时，
 * 由 `triggerShapeProblems()` 报「解析形态异常」，而不是静默跳过 —— 审查方第五轮 B1'''' 实测
 * 这三种写法在 `yaml@2.9.1` 里都**真的生效**（`"paths-ignore":` 确实排掉了 db），而旧解析器
 * 只认裸键 ⇒ 整行被当无关文本 ⇒ 看不见任何条目 ⇒ 静默全绿。
 *
 * @param {string} line
 * @returns {{ indent: number, quoted: boolean, key: string, spacesBeforeColon: number, value: string } | null}
 */
function matchFilterKeyLine(line) {
  const match = /^( *)(['"]?)(paths-ignore|paths)\2( *):(.*)$/.exec(line);
  if (match === null) return null;
  return {
    indent: match[1].length,
    quoted: match[2] !== '',
    key: match[3],
    spacesBeforeColon: match[4].length,
    value: match[5].trim(),
  };
}

/**
 * 解析 `on.<event>.paths` 与 `on.<event>.paths-ignore`（判据⑩ 的输入）。
 *
 * 只认 `on:` 与 `jobs:` 之间那一段，事件键固定在 2 空格缩进、`paths:` / `paths-ignore:` 在
 * 4 空格 —— 与真实文件的风格一致（`run:` 里的正文不会缩进到这个层级，所以不会误捕）。
 * 键名必须裸写：带引号的键、冒号前有空格的键这里**故意不解析**，改由
 * `triggerShapeProblems()` 判红（解析口径收窄是 fail-closed 的一半，不能默默放宽）。
 *
 * 两个键的返回值语义**故意区分两件事**：
 *   · `null`      = 该事件**没有**这个键（`paths` 无过滤 ⇒ 全量触发；`paths-ignore` 无排除）；
 *                   显式空数组（`paths: []`）也算这一档 —— 「一条条目都没有」与「没写」同义。
 *   · `string[]`  = 有过滤，逐个条目按 GitHub 的 glob 语义判覆盖（`pathEntryCovers`）或排除。
 * 把「没有键」和「解析失败成空数组」混为一谈，就会让解析器的 bug 变成一条静默绿灯，
 * 所以下面「反空转」用例会逐事件断言这两者之一，而不是只看最后有没有 problem。
 *
 * @param {string} text workflow 原文
 * @returns {{ paths: Record<string, string[] | null>, ignore: Record<string, string[] | null> }}
 */
function parseTriggerFilters(text) {
  const body = stripCommentLines(text);
  /** @type {Record<string, string[] | null>} */
  const paths = {};
  /** @type {Record<string, string[] | null>} */
  const ignore = {};
  const onIndex = body.search(/^on:\s*$/m);
  if (onIndex === -1) return { paths, ignore };
  const jobsIndex = body.search(/^jobs:\s*$/m);
  const section = body.slice(onIndex, jobsIndex === -1 ? undefined : jobsIndex);

  // 先 trim 再去引号：`paths: ['a', 'b']` 这种逗号后带空格的写法，先把 " 'b'" 的空白去掉
  // 才看得到引号，否则会被当成字面量 `'b'` 报「未建模写法」（审查方第四轮 N1 实测的误红）。
  const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
  const lines = section.split(/\r?\n/);
  let event = null;
  for (let index = 0; index < lines.length; index += 1) {
    // 行尾注释先剥掉：`paths-ignore:   # 说明`（yaml 真值是 null）与 `paths: ['a/**'] # 说明`
    // 都必须按「空」/「行内序列」放行（审查方第五轮 N-a 实测的误红）。
    const line = stripTrailingComment(lines[index]);
    const eventMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (eventMatch !== null) {
      event = eventMatch[1];
      if (!(event in paths)) paths[event] = null;
      if (!(event in ignore)) ignore[event] = null;
      continue;
    }
    if (event === null) continue;

    for (const [key, target] of [['paths', paths], ['paths-ignore', ignore]]) {
      const inline = new RegExp(`^ {4}${key}:\\s*\\[(.*)\\]\\s*$`).exec(line);
      if (inline !== null) {
        const entries = inline[1]
          .split(',')
          .map((item) => unquote(item))
          .filter((item) => item !== '');
        // 显式空数组（`paths: []` / `paths-ignore: []`）等于「没写这个键」，按 null 放行
        // （审查方第四轮 N2：它的语义是「一条条目都没有」，不该被反空转当成解析失败）。
        target[event] = entries.length === 0 ? null : entries;
        break;
      }
      if (new RegExp(`^ {4}${key}:\\s*$`).test(line)) {
        const entries = [];
        // 条目归属按**相对这个键的缩进**算（`blockItemValue`，与白名单共用的同一个判定）：
        // 4/5/6/7/8 空格都是这条键的条目，别再用绝对「6 空格」把它读成「一条条目都没有」。
        const keyIndent = line.length - line.trimStart().length;
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
          const itemLine = stripTrailingComment(lines[cursor]);
          if (itemLine.trim() === '') continue; // 空行 / 纯注释行不打断块序列
          const value = blockItemValue(itemLine, keyIndent);
          if (value === null) break; // 缩进回落到键层、或不是条目 ⇒ 这条键的块序列到此结束
          entries.push(unquote(value.trim()));
        }
        // 块序列一条条目都没有（`paths:` 下面直接是别的键，或只有行尾注释）在 yaml 里就是 `null`，
        // 与 `paths: []` 同义 ⇒ 一律按「没写这个键」放行，别让空数组冒充「有过滤但没条目」。
        target[event] = entries.length === 0 ? null : entries;
        break;
      }
    }
  }
  return { paths, ignore };
}

/** `on.<event>.paths` 逐事件条目（`null` = 无过滤 ⇒ 全量触发）。 */
export function triggerPaths(text) {
  return parseTriggerFilters(text).paths;
}

/** `on.<event>.paths-ignore` 逐事件条目（`null` = 没有任何排除）。 */
export function triggerIgnorePaths(text) {
  return parseTriggerFilters(text).ignore;
}

/**
 * 复算某条臂的**被测实现目录**（判据⑩ 的另一半输入）。两种来源取并集：
 *
 *   **来源 A —— 臂脚本与 workflow `run:` 里出现的 `services/api/src/<首段>`**：首段是顶层目录
 *   或顶层文件（例如 `db`、`app.ts`）。臂脚本是「它到底在验哪段实现」的第一手证据；workflow
 *   自己声明的命令（例如 `node services/api/src/db/migrate.ts up`）同样是实证 —— 光看脚本会把
 *   `deploy-sql-gate.yml` 那种「实现写在 run: 里」的臂算成空集。
 *   **来源 B —— `tests/<域>/` ↔ `services/api/src/<域>`**：臂脚本与 workflow 的 `run:` 文本里
 *   出现的 `tests/<域>/`，按同名域映射到 `services/api/src/<域>`。
 *     · 为什么非要 B：`workbook-staging` 这条臂的脚本一个 `services/api/src/**` 都不 import
 *       （它只 `spawnSync(python3, ['tests/knowledge/test_workbook_staging.py'])`，实现全在
 *       `services/api/src/knowledge/**`）。只用 A 会让这条臂的实现目录是**空集**，于是
 *       「paths 必须覆盖实现目录」对它恒真 —— 那正是本判据要抓的假绿。
 *
 * 两条来源都只保留**磁盘上真实存在**的路径（不凭命名想象目录），并按 `statSync` 标出它是
 * 目录还是单个文件：目录要求 `dir/**` 形态覆盖，文件要求逐字出现（GitHub 的 `paths: [dir]`
 * 只匹配该路径自身，不匹配子文件，所以不能拿裸目录名当覆盖）。
 *
 * @param {string} text workflow 原文（来源 A/B 需要它的 `run:` 文本）
 * @param {readonly string[]} scripts 该臂跑的 `tests/integration/*.mjs`
 * @param {{ root?: string }} [options]
 * @returns {Array<{ path: string, kind: 'dir' | 'file' }>} 按 path 升序
 */
export function implementationPaths(text, scripts, { root = ROOT } = {}) {
  const candidates = new Set();
  const commands = runCommandTexts(text);

  for (const script of scripts) {
    let source;
    try {
      source = readFileSync(join(root, 'tests', 'integration', script), 'utf8');
    } catch {
      continue; // 脚本不存在由判据④/⑤ 点名，这里不重复报
    }
    for (const match of source.matchAll(/services\/api\/src\/([A-Za-z0-9._-]+)/g)) {
      candidates.add(`services/api/src/${match[1]}`);
    }
    for (const match of source.matchAll(/tests\/([A-Za-z0-9._-]+)\//g)) {
      candidates.add(`services/api/src/${match[1]}`);
    }
  }

  for (const command of commands) {
    for (const match of command.matchAll(/services\/api\/src\/([A-Za-z0-9._-]+)/g)) {
      candidates.add(`services/api/src/${match[1]}`);
    }
    for (const match of command.matchAll(/tests\/([A-Za-z0-9._-]+)\//g)) {
      candidates.add(`services/api/src/${match[1]}`);
    }
  }

  const resolved = [];
  for (const candidate of candidates) {
    let stats;
    try {
      stats = statSync(join(root, candidate));
    } catch {
      continue; // 映射出来的目录/文件在盘上不存在 ⇒ 不是真实的被测实现面
    }
    resolved.push({ path: candidate, kind: stats.isDirectory() ? 'dir' : 'file' });
  }
  return resolved.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * 把 Actions 的 path 通配翻成正则 —— 只覆盖**常用子集**，不是完整 glob 方言：
 *   · `**\/`（前导或中段）⇒ `(?:.*\/)?` —— 可跨任意多层，也**可零层**（`a/**\/*` 命中 `a/f.ts`）；
 *   · `**`（结尾）⇒ `.*` —— 该前缀下任意深度；
 *   · `*` ⇒ `[^/]*`（单层，不跨 `/`）；`?` ⇒ `[^/]`；
 *   · 其余字符逐字转义 —— **注意**：转义不等于「支持」，条目形状先过 `unmodeledGlobReason()`
 *     的白名单，`[`、`{`、`(`、`!`、`\` 这类写法在到达本函数之前就被判红（fail-closed）。
 * 这样 `**\/db/**`、`services/api/src/**\/db/**`、`services/api/src/knowledge/**\/*` 都能被正确命中，
 * 而 `services/api/src/*` 仍然不覆盖 `knowledge` 里的任何文件（审查方 M7 的反向要求）。
 */
export function pathGlobToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] !== '*') {
        source += '[^/]*';
      } else if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** 目录目标在「任意深度」上被覆盖时，这几个探针都必须命中（`.every` ⇒ 少一层就不算覆盖）。 */
function descendantProbes(target) {
  return [`${target.path}/probe.ts`, `${target.path}/a/probe.ts`, `${target.path}/a/b/probe.ts`];
}

/**
 * 一个 `paths:` 条目是否覆盖目标实现路径（glob 常用子集语义，`*` / `**`）：
 *   · 目录目标 ⇒ 该目录下**任意深度**的文件都要被同一条 glob 命中才算覆盖
 *     （`dir/**`、`dir/**\/*`、`**\/dir/**` 都算；`dir/*` 只碰直接子文件 ⇒ 不算）；
 *   · 文件目标 ⇒ 该文件路径本身被命中即可。
 */
export function pathEntryCovers(entry, target) {
  const pattern = pathGlobToRegExp(entry);
  if (target.kind === 'file') return pattern.test(target.path);
  return descendantProbes(target).every((probe) => pattern.test(probe));
}

/** 该条目是否是「本想覆盖某棵子树、却只写了单星号」的形态（用于给出 `/**` 的补救提示）。 */
export function singleStarCoversNothing(entry, target) {
  if (!entry.includes('*') || entry.includes('**')) return false;
  if (pathEntryCovers(entry, target)) return false;
  const cut = entry.lastIndexOf('/');
  if (cut <= 0) return false;
  const base = entry.slice(0, cut);
  if (!entry.slice(cut + 1).includes('*')) return false;
  return target.path === base || target.path.startsWith(`${base}/`);
}

/**
 * 一个 `paths-ignore:` 条目是否**排除**到目标实现路径（fail-closed：命中任一文件即判红）。
 *
 * 方向与覆盖判定相反：排除只要「够得着该目录下的**任何一个文件**」就算这条臂对它永不触发，
 * 所以用同一套 glob 语义、探针取 `.some`。**不带 `/**` 的目录字面量**
 * （`paths-ignore: ['services/api/src/knowledge']`）在 Actions 里匹配不到文件 ⇒ 不算排除。
 */
export function ignoreEntryTouches(entry, target) {
  const pattern = pathGlobToRegExp(entry);
  if (target.kind === 'file') return pattern.test(target.path);
  return descendantProbes(target).some((probe) => pattern.test(probe));
}

/**
 * 条目形状白名单：本判据只建模 `*` / `**` 这个常用子集（`?` 也顺手建模，但**不在**白名单里）。
 *
 * 为什么不像 minimatch 那样支持全套方言（`[abc]`、`{a,b}`、`+(x)`、`!` 负向…）：
 * 逐条实现既容易错，又让守卫的复杂度超过被守卫的对象；而**把看不懂的写法当字面量**更糟 ——
 * `paths-ignore: ['services/api/src/[d]b/**']` 会被算成「不匹配」，于是排掉实现目录还全绿。
 * 所以这里 fail-closed：白名单之外的写法一律判红并给改写建议（审查方第三轮 B1''）。
 */
const MODELED_PATH_CHARS = /^[A-Za-z0-9._/ *-]+$/;

/** 该条目是否用了本判据没建模的写法（`null` = 可以用；否则返回一句人话原因）。 */
export function unmodeledGlobReason(entry) {
  if (entry === '') return '是空条目';
  if (entry.startsWith('!')) return '以 `!` 开头 —— Actions 里 `!` 是负向匹配，等于排除';
  if (MODELED_PATH_CHARS.test(entry)) return null;
  const offenders = [...new Set(entry.split('').filter((char) => !/[A-Za-z0-9._/ *-]/.test(char)))];
  return `含未建模写法 ${offenders.map((char) => `\`${char}\``).join(' ')}`;
}

/**
 * ### 判据⑩ 的口径（第八轮架构调整，2026-10-28）：**不解释 YAML，只断言 `on:` 段的书写形态**
 *
 * 判据⑩ 不去「建模 YAML 语义」—— 那条路补一个洞冒一个洞（tag、块序列换行、flow mapping…
 * 每补一处都能再找出一种同样合法、但本判据看不见的写法）。改成**行级白名单**：
 * 先定位 `on:` 块（`on:` 起到下一个顶格键之前），逐行判定，**只允许下面六类形态**，
 * 其余一律判红（fail-closed），红消息点名该行并给出「新写法请另开一片」的出口。
 *
 *   ① 空行 / 纯注释行（`# …` 或 `  # …`）。
 *   ② 事件层裸键：`  <event>:`（`^ {2}[A-Za-z0-9_.-]+:`，可带行尾注释）。
 *   ③ 过滤/参数层：`    <key>: <行内序列 | '引号标量' | "引号标量" | 行尾注释 | 空>`。
 *      含 `    paths:` / `    paths-ignore:`（4 空格、裸键、冒号紧贴）。
 *   ④ 块序列条目：`<比所属键更深或同深的缩进>- <同一行上就有值>`。缩进**相对所属键**算，
 *      由 `blockItemValue()` 这**唯一一个**判定函数负责（白名单与 `parseTriggerFilters()` 共用，
 *      不许再各写一套绝对缩进正则）：4/5/6/7/8 空格都算这条键的条目。`-` 后面必须同行有值 ——
 *      值写在下一行的写法在 yaml 里合法、本判据看不见，所以判红并点名「-」那一行。
 *   ⑤ 事件写成 flow mapping 的唯一放行形态：`  <event>: { … }`，且该行**不含 `paths` 子串**
 *      （`push: {}`、`pull_request: {types: [opened]}` 属此列；藏了 paths 的一律判红）。
 *   ⑥ `    inputs:` / `    with:` 之下的输入声明（`workflow_call` / `workflow_dispatch` 的入参）：
 *      6 空格起的 `key: value` 与 `- value`。那里与 `paths` 同名的键是**输入名不是触发过滤**，
 *      只按白名单放行、不参与覆盖/排除判定（第七轮 B1''''' 的误红出口）。
 *
 * 白名单之外还有几条**更具体**的诊断（在通用判红之前先命中，给出可操作的改法）：
 * 事件键带引号、过滤键带引号 / 冒号前有空格 / 缩进不是 4 空格、显式键语法 `? paths-ignore`、
 * YAML 锚点 `&x` / 别名 `*x` / 合并键 `<<:`、过滤键取值既非空也非行内序列。
 *
 * 一句话口径：**判据⑩ 不判断「YAML 会怎么解析」，只判断「这行是不是这六类之一」**；
 * 看不懂 = 判红，绝不让「解析器看不见」变成「当作没写 paths ⇒ 全量触发」。
 * 要支持新写法请另开一片，不要在本判据里放宽。
 */
const ON_EVENT_LINE = /^ {2}[A-Za-z0-9_.-]+:\s*(?:#.*)?$/;
const ON_KEY_LINE = /^ {4}[A-Za-z0-9_.-]+:\s*(?:\[[^\]]*\]|'(?:[^']*)'|"(?:[^"]*)"|#.*)?\s*$/;
const ON_EVENT_FLOW_LINE = /^ {2}[A-Za-z0-9_.-]+:\s*\{.*\}\s*(?:#.*)?$/;
const ON_NESTED_ENTRY_LINE = /^ {6,}(?:[A-Za-z0-9_.-]+:|-)(?:[ \t].*|)$/;

/**
 * 一个「事件名」的允许写法：裸名（`push`），或带引号的标量（`"push"` / `'pull_request'`）。
 *
 * 第十一轮：`on:` 这一行原来只认裸名，于是 `on: "push"` / `on: 'pull_request'` 被误红，
 * 而 `on: ["push","pull_request"]`（行内列表带引号）却是放行的 —— 同一族写法必须同族同待遇，
 * 否则「加一对引号」这一个字符就能把合法 YAML 判成红。引号内不做额外放宽（那是另一片的事）。
 */
const EVENT_NAME = String.raw`(?:[A-Za-z0-9_.-]+|"(?:[^"\\]*)"|'(?:[^'\\]*)')`;

/**
 * 块序列条目的**唯一**判定口径：白名单 ④ 与 `parseTriggerFilters()` 共用这一个函数。
 *
 * 条目 = 缩进**不比所属键浅**（`>=` 键缩进）、以 `-` 开头、且 `-` 后面同一行就有值。
 * 为什么按相对缩进：YAML 的块序列本来就不限定缩进 —— `paths:` 的条目可以写在键的同一列，
 * 也可以多缩几格，7/8 空格一样合法。用「绝对 6 空格」判归属，会让 4/5/7/8 空格的合法写法在
 * 解析器里读成「一条条目都没有 ⇒ 没有过滤 ⇒ 全量触发」，而这正是本判据要堵的
 * 「看不见 = 没写」假绿（第九轮审查方实测：4/5 空格条目注入后守卫 EXIT=0 全绿）。
 *
 * @param {string} line 已去行尾注释的一行
 * @param {number} keyIndent 该块序列所属键的缩进（空格数）
 * @returns {string | null} 条目原文（未去引号、未 trim）；不是这条键的条目时返回 `null`
 */
export function blockItemValue(line, keyIndent) {
  const match = new RegExp(`^ {${keyIndent},}-[ \\t]+(\\S.*)$`).exec(line);
  return match === null ? null : match[1];
}

/** 六类形态清单，写进红消息里，让人知道能写什么。 */
const ON_SECTION_FORMS = '① 空行/纯注释行；② 事件层裸键 `  <event>:`；③ `    <key>: <行内序列|引号标量|空|行尾注释>`；'
  + '④ 块序列条目 `<不比所属键浅的缩进>- <同行有值>`；⑤ 不含 `paths` 的事件 flow mapping `  <event>: {…}`；'
  + '⑥ `inputs:` / `with:` 之下的输入声明';

/** 白名单之外、但能给出更具体改法的诊断（返回 `null` = 交给白名单判定）。 */
function nearMissProblem(line, nested) {
  if (/^ {2}['"][A-Za-z0-9_.-]+['"]:\s*(?:#.*)?$/.test(line)) {
    return `解析形态异常：事件键写成了带引号的形式（「${line.trim()}」），解析器只认裸键（\`  pull_request:\`）`
      + ' ⇒ 该事件的触发面根本没被检查到（这既不是「没写 paths」，也不是「被排除」）。';
  }
  // 事件写成 flow mapping 且行里藏了 paths：白名单⑤ 只放行「不含 paths」的 flow mapping。
  if (ON_EVENT_FLOW_LINE.test(line) && /paths/.test(line)) {
    return `解析形态异常：事件写成 flow mapping（「${line.trim()}」）—— 本判据解析不到其触发过滤`
      + '（这既不是「没有这个键」，也不是「被排除」）；请把事件展开成块写法，把 paths / paths-ignore'
      + ' 写成 `    paths:` 下面的块序列。';
  }
  if (/^ {4}\?\s/.test(line)) {
    return `解析形态异常：\`on:\` 段落里出现显式键语法（「${line.trim()}」）—— yaml 真值里这条过滤/排除`
      + '照样生效，而本判据当成无关文本跳过（这既不是「没有这个键」，也不是「被排除」）；'
      + '请改写成裸键 + 块序列或行内序列。';
  }
  // 行尾注释先剥掉再看取值：`paths-ignore:   # 说明` 的取值是空（第五轮 N-a），别当成标量拒掉。
  const filterKey = matchFilterKeyLine(stripTrailingComment(line));
  if (filterKey !== null) {
    if (nested) return null; // 输入声明域里的键：白名单⑥ 负责放行，不按「过滤键」判形态
    if (filterKey.quoted) {
      return `解析形态异常：\`${filterKey.key}:\` 的键名写成了带引号的形式（「${line.trim()}」）`
        + ' —— yaml 解析器照收不误、过滤/排除都真的生效，而本判据只认裸键'
        + '（这既不是「没有这个键」，也不是「被排除」）；请改写成裸键。';
    }
    if (filterKey.spacesBeforeColon > 0) {
      return `解析形态异常：\`${filterKey.key}\` 与冒号之间有 ${filterKey.spacesBeforeColon} 个空格`
        + `（「${line.trim()}」）—— yaml 解析器照收不误、过滤/排除都真的生效，而本判据只认`
        + '紧贴冒号的裸键 `paths:`（这既不是「没有这个键」，也不是「被排除」）；请删掉冒号前的空格。';
    }
    if (filterKey.indent !== 4) {
      return `解析形态异常：\`${filterKey.key}:\` 的缩进是 ${filterKey.indent} 空格（解析器只认 4 空格）`
        + ' ⇒ 该键被当成无关文本跳过（这既不是「没有这个键」，也不是「被排除」）。';
    }
    const value = filterKey.value;
    if (value !== '' && !/^\[.*\]$/.test(value) && !/^(['"]).*\1$/.test(value)) {
      return `解析形态异常：\`${filterKey.key}:\` 的取值既不是空、也不是行内序列 \`[...]\` / 引号标量（实测「${value}」）`
        + ' —— 锚点/别名/块序列换行等写法会让本判据看不见真实条目，而 yaml 解析器可是照收不误'
        + '（这既不是「没有这个键」，也不是「被排除」）；请写成块序列或 \`paths: [\'a/**\']\`。';
    }
    return null;
  }
  if (/<<\s*:/.test(line)) {
    return '解析形态异常：`on:` 段落里出现 YAML 合并键（`<<:`）—— 合并进来的 paths / paths-ignore 条目'
      + '本判据解析不到，等于让这条臂的触发面逃过检查（这既不是「没有这个键」，也不是「被排除」）。';
  }
  const anchor = /&\s*[A-Za-z_][\w-]*/.exec(line);
  if (anchor !== null) {
    return `解析形态异常：\`on:\` 段落里出现 YAML 锚点定义（「${anchor[0]}」）—— 别名的真实取值本判据解析不了，`
      + '于是「看不见 = 没写 = 全量触发」会掩盖真实的收窄/排除（这既不是「没有这个键」，也不是「被排除」）。';
  }
  const alias = /(?:^|[\s"'[])(\*[A-Za-z_][\w-]*)/.exec(line);
  if (alias !== null) {
    return `解析形态异常：\`on:\` 段落里出现 YAML 别名引用（「${alias[1]}」）—— 真实条目在锚点那头，`
      + '本判据看不见，等于让这条臂的触发面逃过检查（这既不是「没有这个键」，也不是「被排除」）。';
  }
  return null;
}

/** `on:` 段落的行级白名单：不在六类形态里的一律判红（fail-closed）。 */
export function triggerShapeProblems(text) {
  const body = stripCommentLines(text ?? '');
  const lines = body.split(/\r?\n/);
  const onIndex = lines.findIndex((line) => /^on:/.test(line));
  if (onIndex === -1) return [];
  let endIndex = lines.length;
  for (let index = onIndex + 1; index < lines.length; index += 1) {
    if (/^[A-Za-z0-9_."'-]+:/.test(lines[index])) {
      endIndex = index;
      break;
    }
  }
  const section = lines.slice(onIndex, endIndex);
  const problems = [];
  let nested = false;
  // 最近一个「键」的缩进。块序列条目的归属**相对它**算，不再用绝对缩进常量（第九轮）：
  // 绝对常量既会漏判（4/5 空格条目读不到 ⇒ 当作没写 paths ⇒ 全量触发），也会误红（7/8 空格）。
  let keyIndent = null;

  for (const [offset, rawLine] of section.entries()) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '') continue; // ① 空行
    if (/^\s*#/.test(line)) continue; // ① 纯注释行
    if (offset === 0) {
      // `on:` 自己放行三种：块写法 / 单个事件名（裸名或带引号）/ 行内事件列表（可带引号、可混排）——
      // 这三种都藏不进 paths / paths-ignore（没有过滤层，列表里只有事件名）。
      // 只有 `on: {…}` 这种 flow mapping 能藏过滤，判红；其余看不懂的写法单独一句文案，别混成 flow mapping。
      const isBlock = /^on:\s*(?:#.*)?$/.test(line);
      const isEventScalar = new RegExp(`^on:\\s*${EVENT_NAME}\\s*(?:#.*)?$`).test(line);
      const isEventList = new RegExp(`^on:\\s*\\[\\s*${EVENT_NAME}(?:\\s*,\\s*${EVENT_NAME})*\\s*,?\\s*\\]\\s*(?:#.*)?$`).test(line);
      if (!isBlock && !isEventScalar && !isEventList) {
        if (/^on:\s*\{/.test(line)) {
          problems.push(
            `判据⑩ 解析形态不支持（fail-closed）：${line.trim()} —— \`on: {…}\` 这种 flow mapping 能藏触发过滤，`
              + `本判据看不见其中任何 \`paths\` / \`paths-ignore\`；\`on:\` 段只接受 ${ON_SECTION_FORMS}`
              + '（`on: push`、`on: "push"`、`on: [push, pull_request]` 这类简写没有过滤层，是放行的）。',
          );
        } else {
          problems.push(
            `判据⑩ 解析形态不支持（fail-closed）：${line.trim()} —— 不认识的 \`on:\` 写法（本判据只支持块写法 / `
              + '单个事件名 / 行内事件列表）；要支持新写法请另开一片，不要在本判据里放宽。',
          );
        }
      }
      continue;
    }
    if (nested && line.length - line.trimStart().length <= 4) nested = false; // 回到事件层
    if (/^ {4}(inputs|with):\s*(?:#.*)?$/.test(line)) {
      nested = true; // ⑥ 进入输入声明域
      continue;
    }
    if (nested && ON_NESTED_ENTRY_LINE.test(line)) continue; // ⑥ 域内的键/条目
    const nearMiss = nearMissProblem(line, nested);
    if (nearMiss !== null) {
      problems.push(nearMiss);
      continue;
    }
    const bare = stripTrailingComment(line); // 白名单按「去掉行尾注释」后的样子判，注释本身不限制
    if (ON_EVENT_FLOW_LINE.test(bare) && !/paths/.test(bare)) {
      keyIndent = bare.length - bare.trimStart().length; // ⑤
      continue;
    }
    if (ON_EVENT_LINE.test(bare)) {
      keyIndent = bare.length - bare.trimStart().length; // ②
      continue;
    }
    if (ON_KEY_LINE.test(bare)) {
      keyIndent = bare.length - bare.trimStart().length; // ③
      continue;
    }
    // ④ 块序列条目：缩进相对**上一个键**判（`blockItemValue` 是唯一口径，和解析器同一个函数）。
    // 这样 `paths:` 下 4/5/6/7/8 空格的条目、`schedule:` 下 4 空格的 `- cron:` 都按各自所属的键放行。
    if (keyIndent !== null && blockItemValue(bare, keyIndent) !== null) continue;
    problems.push(
      `判据⑩ 解析形态不支持（fail-closed）：${line.trim()} —— on: 段只接受 ${ON_SECTION_FORMS}；`
        + '要支持新写法请另开一片，不要在本判据里放宽。',
    );
  }
  return problems;
}

/** 判据⑩ 的单臂问题清单：解析形态 → 条目形状 → 语义（覆盖 / 排除）。 */
export function triggerCoverageProblems(record) {
  const problems = [];
  const ignoreByEvent = record.ignore ?? {};

  // ① 解析形态：键根本没被解析到时，后面的语义判定全是空转，必须先红。
  for (const reason of triggerShapeProblems(record.text)) problems.push(`${record.file}：${reason}`);

  // ② 条目形状：白名单之外的 glob 写法一律拒绝（当字面量处理 = 静默排掉实现目录还全绿）。
  for (const [key, table] of [['paths', record.paths], ['paths-ignore', ignoreByEvent]]) {
    for (const [event, entries] of Object.entries(table)) {
      if (entries === null || entries === undefined) continue;
      for (const entry of entries) {
        const reason = unmodeledGlobReason(entry);
        if (reason === null) continue;
        problems.push(
          `${record.file}：\`on.${event}.${key}\` 里的「${entry}」${reason} —— 本判据只建模 \`*\` / \`**\` 的常用子集，`
            + '其余 glob 写法一律 fail-closed 拒绝（若当字面量处理，就会变成「悄悄排掉实现目录还全绿」）；'
            + '请改写成 `dir/**` 或 `dir/*`，或先扩展 pathGlobToRegExp() 再放宽这张白名单。',
        );
      }
    }
  }

  // ③ 语义：排除通道。
  for (const [event, ignoreEntries] of Object.entries(ignoreByEvent)) {
    if (ignoreEntries === null || ignoreEntries === undefined) continue; // 没有排除 ⇒ 无事
    if (ignoreEntries.some((entry) => unmodeledGlobReason(entry) !== null)) continue; // 形状问题已报，别再叠一条语义结论
    for (const target of record.implPaths) {
      const hit = ignoreEntries.find((entry) => ignoreEntryTouches(entry, target));
      if (hit === undefined) continue;
      problems.push(
        `${record.file}：\`on.${event}.paths-ignore\` 用「${hit}」把被测实现目录「${target.path}`
          + `${target.kind === 'dir' ? '/**' : ''}」排除掉了 —— 这条臂对它**永不触发**，`
          + '比「没写 paths」更隐蔽；要么删掉这条排除，要么用 `paths:` 显式列出实现目录。',
      );
    }
  }

  // ④ 语义：覆盖通道。
  for (const [event, entries] of Object.entries(record.paths)) {
    if (entries === null) continue; // 无 paths ⇒ 全量触发，天然覆盖
    if (entries.some((entry) => unmodeledGlobReason(entry) !== null)) continue; // 同上：形状问题已点名
    for (const target of record.implPaths) {
      if (entries.some((entry) => pathEntryCovers(entry, target))) continue;
      const shallow = entries.find((entry) => singleStarCoversNothing(entry, target));
      if (shallow !== undefined) {
        problems.push(
          `${record.file}：\`on.${event}.paths\` 用「${shallow}」当覆盖 —— 单星号不跨 \`/\`，`
            + `GitHub 匹配不到「${target.path}${target.kind === 'dir' ? '/**' : ''}」里面子目录的文件，`
            + `等于没覆盖；改成 \`${target.path}/**\`。`,
        );
        continue;
      }
      problems.push(
        `${record.file}：\`on.${event}.paths\` 没有覆盖被测实现目录「${target.path}${target.kind === 'dir' ? '/**' : ''}」`
          + ' —— 只改这一处实现不会触发这条臂，真库读数会静默下降；'
          + '把该条目加进这份 paths（与现有条目同风格，不重排其它行）。',
      );
    }
  }
  return problems;
}

/**
 * 把「已登记的臂 → 它的 paths / paths-ignore 与实现目录」一次算齐（判据⑩ 的扫描面）。
 * 扫描面 = `REAL_PG_WORKFLOWS`（5 条逐份守卫的）+ `COVERED_ELSEWHERE`（3 条由别的测试守卫的），
 * 后者没有登记 `scripts`，用 workflow 自己的 `run:` 文本反推。
 */
export function armTriggerRecords({ root = ROOT } = {}) {
  const arms = [
    ...REAL_PG_WORKFLOWS.map((spec) => ({ file: spec.file, scripts: [...spec.scripts] })),
    ...COVERED_ELSEWHERE.map((entry) => ({ file: entry.file, scripts: scriptsRunBy(readWorkflow(entry.file)) })),
  ];
  return arms.map((arm) => {
    const text = readWorkflow(arm.file);
    return {
      ...arm,
      text,
      paths: triggerPaths(text),
      ignore: triggerIgnorePaths(text),
      implPaths: implementationPaths(text, arm.scripts, { root }),
    };
  });
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

test('判据⑩ 触发面：每条登记臂的 `paths:`（存在时）必须覆盖它的被测实现目录', () => {
  const problems = armTriggerRecords().flatMap((record) => triggerCoverageProblems(record));
  assert.deepEqual(problems, [], `触发面覆盖不足：\n${problems.join('\n')}`);
});

test('判据⑩ 反空转：扫描面 ≥ 5 条臂，且每条都被真的解析过 paths 与实现目录', () => {
  const records = armTriggerRecords();
  assert.ok(records.length >= 5, `判据⑩ 只扫到 ${records.length} 条臂（要求 ≥ 5）`);

  for (const record of records) {
    assert.ok(record.paths !== null && typeof record.paths === 'object', `${record.file}：没解析出 on.* 事件`);
    const events = Object.keys(record.paths);
    assert.ok(events.length >= 1, `${record.file}：on: 下没解析出任何事件（解析器静默失效）`);
    assert.ok(events.includes('pull_request'), `${record.file}：登记的真库臂必须在 pull_request 上跑`);
    for (const [event, entries] of Object.entries(record.paths)) {
      // 空数组只会来自解析失败 —— 那会让覆盖判据变成恒真，必须在这里先红。
      // 文案与「语义判定」分开：这里是**解析形态**问题（键存在但一条条目都没读出来），
      // 不是「被排除」，也不是「覆盖不足」（审查方 X7/X8 的教训）。
      assert.ok(
        entries === null || (Array.isArray(entries) && entries.length > 0),
        `${record.file}：\`on.${event}.paths\` 解析形态异常 —— 该键存在但一条条目都没解析出来（应为 null 表示没有这个键），`
          + '常见原因是缩进不是 4/6 空格或用了 flow 之外的写法；这既不是「被排除」也不是「覆盖不足」。',
      );
    }
  }

  // 每条臂都必须复算出至少 1 个实现目录 —— 空集会让「paths 必须覆盖实现目录」对它恒真，
  // 那正是「没找到登记源就静默跳过」的形态。
  const empty = records.filter((record) => record.implPaths.length === 0).map((record) => record.file);
  assert.deepEqual(empty, [], `这些臂没算出任何被测实现目录（判据对它们是空判）：${empty.join('、')}`);

  // 至少一条臂真的带 paths 过滤，且至少一条臂不带（两种语义都被行使过，判据不是空转）。
  // 判别面读数写进消息里：8 条已登记臂、今天只有 1 条真带 `paths:` —— 这个比例要能一眼看见，
  // 而不是只活在一次性的 dump 里（审查方 §4.1）。
  const filtered = records.filter((record) => Object.values(record.paths).some((entries) => entries !== null));
  const unfiltered = records.filter((record) => Object.values(record.paths).every((entries) => entries === null));
  const reading = `已登记 ${records.length} 条臂，带 paths 过滤 ${filtered.length} 条（${filtered
    .map((record) => record.file)
    .join('、') || '无'}），全量触发 ${unfiltered.length} 条`;
  // 绿的时候也要能看见读数（审查方 §4.2）：只写在 assert 消息里等于「红了才看得见」。
  console.log(`[判据⑩ 读数] ${reading}`);
  assert.ok(filtered.length >= 1, `没有任何一条臂带 \`paths:\` 过滤 ⇒ 覆盖判据整体没被行使（${reading}）`);
  assert.ok(unfiltered.length >= 1, `所有臂都带 \`paths:\` 过滤 ⇒ 「无过滤 = 全量触发」这一支没被行使（${reading}）`);
  // 「8 条臂只有 1 条真带 paths」这个比例本身要被钉住：唯一那条就是 D04 的靶，
  // 它一旦被人「顺手」加上别的过滤形态、或读到这里变成 0 条，都不许静默滑过去。
  // 只断言「workbook-staging 在里面」而不断言「只有它」：别的臂哪天真的按路径收窄是合理演进，
  // 不该让反空转用例替它判红（审查方第五轮 N-b 实测的构造副作用）。
  assert.ok(
    filtered.some((record) => record.file === 'workbook-staging.yml'),
    `带 \`paths:\` 过滤的臂里必须有 workbook-staging.yml（D04 的靶），实测：${JSON.stringify(filtered.map((record) => record.file))}`,
  );

  // `paths-ignore` 这一支必须被真的解析过（哪怕今天全仓 0 处）：每条臂都要给出具体结论。
  for (const record of records) {
    assert.ok(record.ignore !== undefined && typeof record.ignore === 'object', `${record.file}：没解析出 paths-ignore 集合`);
    for (const [event, entries] of Object.entries(record.ignore)) {
      assert.ok(
        entries === null || (Array.isArray(entries) && entries.length > 0),
        `${record.file}：\`on.${event}.paths-ignore\` 解析形态异常 —— 该键存在但一条条目都没解析出来（应为 null 表示没有这个键）；`
          + '这既不是「被排除」也不是「没有排除」。',
      );
    }
  }

  // 口径自证：workbook-staging 的实现目录必须复算出 `services/api/src/knowledge`（D04 的靶）。
  const workbook = records.find((record) => record.file === 'workbook-staging.yml');
  assert.ok(workbook !== undefined, '扫描面里必须有 workbook-staging.yml');
  assert.ok(
    workbook.implPaths.some((target) => target.path === 'services/api/src/knowledge'),
    `workbook-staging.yml 的实现目录没有复算出 services/api/src/knowledge：${JSON.stringify(workbook.implPaths)}`,
  );
});

/** 在内存里用改过的文本重算一条臂的触发面记录（不写盘；判别力自证与两条 fail-closed 用例共用）。 */
export function armRecordFrom(record, text) {
  return { ...record, text, paths: triggerPaths(text), ignore: triggerIgnorePaths(text) };
}

/** 从文本里删掉一条 `paths:` 条目（块状 `- 'x'` 与 flow 列表里的 `'x'` 都认；审查方 M9）。 */
export function stripPathEntry(text, entry) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .split(/\r?\n/)
    .filter((line) => ![`- '${entry}'`, `- "${entry}"`, `- ${entry}`].includes(line.trim()))
    .join('\n')
    .replace(new RegExp(`(['"])${escape(entry)}\\1,\\s*`, 'g'), '')
    .replace(new RegExp(`,\\s*(['"])${escape(entry)}\\1`, 'g'), '');
}

test('判据⑩ 判别力自证：删掉真正提供覆盖的那条 paths ⇒ 两条事件都要被点名', () => {
  const record = armTriggerRecords().find((candidate) => candidate.file === 'workbook-staging.yml');
  const target = record.implPaths.find((candidate) => candidate.path === 'services/api/src/knowledge');
  assert.ok(target !== undefined, '扫描面里必须能从 workbook-staging.yml 复算出 services/api/src/knowledge');

  // 从数据里取「今天真正在提供覆盖」的条目，而不是硬编码某一行文本：
  // 把条目改写成 `**/knowledge/**` 之类的等价写法时，自证要跟着走（否则改个等价写法就假红）。
  const covering = (record.paths.pull_request ?? []).filter((entry) => pathEntryCovers(entry, target));
  assert.ok(
    covering.length >= 1,
    `自证前提：workbook-staging.yml 的 on.pull_request.paths 今天没有任何条目覆盖 ${target.path}（覆盖判据本身就该红），实测：${JSON.stringify(record.paths.pull_request)}`,
  );

  let stripped = record.text;
  for (const entry of covering) stripped = stripPathEntry(stripped, entry);
  assert.notEqual(stripped, record.text, '删条目必须真的改变文本（否则测的是空替换）');

  const problems = triggerCoverageProblems(armRecordFrom(record, stripped));
  assert.ok(
    problems.some((problem) => problem.includes('services/api/src/knowledge')),
    `删掉该条目后判据必须点名 services/api/src/knowledge，实测：${JSON.stringify(problems)}`,
  );
  assert.ok(
    problems.some((problem) => problem.includes('on.pull_request.paths')),
    '删掉该条目后 pull_request 这一支必须被点名',
  );
  assert.ok(
    problems.some((problem) => problem.includes('on.push.paths')),
    '删掉该条目后 push 这一支必须被点名',
  );
});

/**
 * 造一条**自包含**的内存臂记录（不读仓库文件）。
 * 这样做是为了让 fail-closed 用例不依赖真文件当下有没有同名键 —— 否则「往真文件里注入第二条
 * `paths-ignore`」会被解析器按「取第一条」串味，让无关排除（`docs/**`）也红（审查方撞键假警报）。
 */
export function syntheticArm({ implPaths, paths = null, ignore = null, file = 'synthetic-arm.yml' }) {
  const lines = ['name: synthetic arm', 'on:', '  pull_request:'];
  if (paths !== null) {
    lines.push('    paths:');
    for (const entry of paths) lines.push(`      - '${entry}'`);
  }
  if (ignore !== null) {
    lines.push('    paths-ignore:');
    for (const entry of ignore) lines.push(`      - '${entry}'`);
  }
  lines.push(
    '  push:',
    '    branches: [main]',
    'jobs:',
    '  synthetic:',
    '    runs-on: ubuntu-24.04',
    '    steps:',
    '      - run: node tests/integration/catalog-pg.mjs',
  );
  const text = lines.join('\n');
  return { file, scripts: [], implPaths, text, paths: triggerPaths(text), ignore: triggerIgnorePaths(text) };
}

test('判据⑩ 对 `paths-ignore` 用 glob 常用子集语义：通配排除必须点名，无关排除与目录字面量必须放行', () => {
  const db = { path: 'services/api/src/db', kind: 'dir' };

  // ① 真的把实现目录排掉的四种写法（含前导 `**` 与中段 `**` —— 这是上一版的盲点）。
  const excluded = [
    'services/api/src/db/**',
    '**/db/**',
    'services/api/src/**/db/**',
    'services/api/src/db/*',
  ];
  for (const entry of excluded) {
    const record = syntheticArm({ implPaths: [db], ignore: [entry] });
    assert.deepEqual(record.ignore.pull_request, [entry], `「${entry}」必须被解析出来（解析器看不见它，判据就永远绿）`);
    const problems = triggerCoverageProblems(record);
    assert.ok(
      problems.some(
        (problem) => problem.includes('on.pull_request.paths-ignore') && problem.includes('services/api/src/db'),
      ),
      `paths-ignore「${entry}」排掉实现目录必须被点名，实测：${JSON.stringify(problems)}`,
    );
  }

  // ② 反面控制：无关排除（`docs/**`）与「不带 `/**` 的目录字面量」都必须放行。
  //    后者在 Actions 里匹配不到任何**文件**（目录本身不是变更），判红就是过度敏感。
  for (const entry of ['docs/**', 'services/api/src/db']) {
    const record = syntheticArm({ implPaths: [db], ignore: [entry] });
    assert.deepEqual(
      triggerCoverageProblems(record),
      [],
      `paths-ignore「${entry}」不该被判红，实测：${JSON.stringify(triggerCoverageProblems(record))}`,
    );
  }

  // ③ 真仓读数（只打印、不硬钉）：把「今天有几条臂带 paths-ignore」变成可见读数，
  //    而不是一条「必须今天恰好为 0」的状态锁 —— 后者会让「给某条臂加一条无关排除」这种
  //    合法改动凭空变红（审查方 M6d：`docs/**` 必须放行）。
  const withIgnore = armTriggerRecords()
    .filter((record) => Object.values(record.ignore).some((entries) => entries !== null))
    .map((record) => record.file);
  console.log(
    `[判据⑩ 读数] paths-ignore：今天 ${withIgnore.length} 条臂带排除键（${withIgnore.join('、') || '无'}）；` +
      '排除通道的判红/放行形态由上面的内存夹具守住',
  );
});

test('判据⑩ 覆盖判定用 glob 常用子集语义：`/**\/*`、`**\/knowledge/**` 算覆盖，单星号不算', () => {
  const knowledge = { path: 'services/api/src/knowledge', kind: 'dir' };

  for (const entry of [
    'services/api/src/knowledge/**',
    'services/api/src/knowledge/**/*',
    'services/api/src/**/knowledge/**',
    '**/knowledge/**',
  ]) {
    assert.equal(pathEntryCovers(entry, knowledge), true, `「${entry}」在 GitHub 语义下确实覆盖该目录`);
    const record = syntheticArm({ implPaths: [knowledge], paths: [entry] });
    assert.deepEqual(
      triggerCoverageProblems(record),
      [],
      `「${entry}」不该被判「没有覆盖」，实测：${JSON.stringify(triggerCoverageProblems(record))}`,
    );
  }

  // 反向要求（M7 不得被放宽）：单星号不跨 `/` ⇒ 不覆盖子树，但覆盖直接子文件。
  assert.equal(pathEntryCovers('services/api/src/*', knowledge), false, '`dir/*` 不得当成子树覆盖（审查方 M7）');
  assert.equal(
    pathEntryCovers('services/api/src/*', { path: 'services/api/src/app.ts', kind: 'file' }),
    true,
    '`dir/*` 应当覆盖直接子文件（放宽这一条会误报合法的单层过滤）',
  );
});

test('判据⑩ 单星号不算覆盖：`services/api/src/*` 必须点名并提示改用 `/**`', () => {
  const record = armTriggerRecords().find((candidate) => candidate.file === 'workbook-staging.yml');
  const target = record.implPaths.find((candidate) => candidate.path === 'services/api/src/knowledge');
  // 同样从数据里取「今天真正提供覆盖的那条条目」，不硬编码文本。
  const covering = (record.paths.pull_request ?? []).filter((entry) => pathEntryCovers(entry, target));
  assert.ok(
    covering.length >= 1,
    `自证前提：workbook-staging.yml 今天没有条目覆盖 ${target.path}（那本身就是覆盖判据的红），实测：${JSON.stringify(record.paths.pull_request)}`,
  );

  const swapped = record.text.split(`'${covering[0]}'`).join("'services/api/src/*'");
  assert.notEqual(swapped, record.text, `变异前提：文本里必须真有 '${covering[0]}' 这一条`);

  const problems = triggerCoverageProblems(armRecordFrom(record, swapped));
  assert.ok(
    problems.some((problem) => problem.includes('services/api/src/*') && problem.includes('/**')),
    `单星号必须被点名并提示改成 \`/**\`，实测：${JSON.stringify(problems)}`,
  );
  assert.ok(
    !problems.some((problem) => problem.includes('没有覆盖')),
    `单星号要给出「改成 /**」的具体补救，而不是笼统的「没有覆盖」：${JSON.stringify(problems)}`,
  );
});

test('判据⑩ 未建模的 glob 写法 fail-closed：`[d]b`、`{a,b}`、`+(x)`、`!` 负向都必须点名', () => {
  const db = { path: 'services/api/src/db', kind: 'dir' };

  // 三条 minimatch 扩展语法：当字面量处理就会「匹配不到 ⇒ 没排除 ⇒ 全绿」，所以必须 fail-closed。
  for (const entry of ['services/api/src/[d]b/**', 'services/api/src/{db,knowledge}/**', 'services/api/src/+(db)/**']) {
    const asIgnore = triggerCoverageProblems(syntheticArm({ implPaths: [db], ignore: [entry] }));
    assert.ok(
      asIgnore.some((problem) => problem.includes(entry) && problem.includes('未建模')),
      `排除侧「${entry}」必须被判「未建模写法」，实测：${JSON.stringify(asIgnore)}`,
    );
    assert.ok(
      !asIgnore.some((problem) => problem.includes('永不触发')),
      `形状越界只报一条形态结论，别再叠「永不触发」：${JSON.stringify(asIgnore)}`,
    );

    const asPaths = triggerCoverageProblems(syntheticArm({ implPaths: [db], paths: [entry] }));
    assert.ok(
      asPaths.some((problem) => problem.includes(entry) && problem.includes('未建模')),
      `覆盖侧「${entry}」必须被判「未建模写法」，实测：${JSON.stringify(asPaths)}`,
    );
    assert.ok(
      !asPaths.some((problem) => problem.includes('没有覆盖')),
      `形状越界只报一条形态结论，别再叠「没有覆盖」：${JSON.stringify(asPaths)}`,
    );
  }

  // `!` 在 Actions 里是负向匹配（等于排除），同样不许当字面量放过去。
  const bang = triggerCoverageProblems(
    syntheticArm({ implPaths: [db], paths: ['services/api/src/db/**', '!services/api/src/knowledge/**'] }),
  );
  assert.ok(
    bang.some((problem) => problem.includes('!services/api/src/knowledge/**') && problem.includes('负向匹配')),
    `\`!\` 负向条目必须被点名，实测：${JSON.stringify(bang)}`,
  );

  // 既有五条常用写法必须仍然放行（白名单不许误伤）。
  for (const entry of ['docs/**', 'services/api/src/knowledge/**', 'services/api/src/*', '**/db/**', 'services/api/src/**/db/**']) {
    assert.equal(unmodeledGlobReason(entry), null, `「${entry}」属于已建模写法，不该被形状白名单拒绝`);
  }
});

test('判据⑩ 解析形态异常与语义判定分开报：引号事件键 / 8 空格 paths-ignore', () => {
  const db = { path: 'services/api/src/db', kind: 'dir' };
  const base = syntheticArm({ implPaths: [db], paths: ['services/api/src/db/**'], ignore: ['docs/**'] });

  // X8：事件键带引号 ⇒ 键根本没被解析到。
  const quoted = base.text.replace('  pull_request:', '  "pull_request":');
  assert.notEqual(quoted, base.text, '注入前提：合成臂必须有裸事件键 `  pull_request:`');
  const quotedProblems = triggerCoverageProblems(armRecordFrom(base, quoted));
  assert.ok(
    quotedProblems.some((problem) => problem.includes('解析形态异常') && problem.includes('带引号')),
    `引号事件键必须报「解析形态异常」，实测：${JSON.stringify(quotedProblems)}`,
  );
  assert.ok(
    !quotedProblems.some((problem) => problem.includes('永不触发') || problem.includes('没有覆盖')),
    `形态问题不许被说成「被排除」或「没覆盖」：${JSON.stringify(quotedProblems)}`,
  );

  // X7：`paths-ignore:` 缩进 8 空格 ⇒ 该键被当成无关文本跳过。
  const indented = base.text.replace('    paths-ignore:', '        paths-ignore:').replace(/\n {6}- 'docs\/\*\*'/, "\n          - 'docs/**'");
  assert.notEqual(indented, base.text, '注入前提：合成臂必须有 4 空格的 `    paths-ignore:`');
  const indentedProblems = triggerCoverageProblems(armRecordFrom(base, indented));
  assert.ok(
    indentedProblems.some((problem) => problem.includes('解析形态异常') && problem.includes('缩进是 8 空格')),
    `8 空格缩进必须报「解析形态异常」，实测：${JSON.stringify(indentedProblems)}`,
  );
  assert.ok(
    !indentedProblems.some((problem) => problem.includes('永不触发')),
    `形态问题不许被说成「被排除」：${JSON.stringify(indentedProblems)}`,
  );
});

test('判据⑩ YAML 锚点 / 别名 / 合并键 fail-closed：四种写法都必须红并点名', () => {
  const db = { path: 'services/api/src/db', kind: 'dir' };
  const tail = 'jobs:\n  synthetic:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: node tests/integration/catalog-pg.mjs\n';
  const armWith = (body) =>
    triggerCoverageProblems(armRecordFrom({ file: 'anchor-arm.yml', implPaths: [db] }, `name: anchor arm\non:\n${body}${tail}`));

  const shapeRed = (problems, marker) =>
    problems.some((problem) => problem.includes('解析形态异常') && problem.includes(marker));

  // ① 锚点在 `push.paths` 上定义，真实条目被本判据的取值形态检查挡住。
  const definedOnPush = armWith(
    "  push:\n    branches: [main]\n    paths: &ignore-db\n      - 'services/api/src/db/**'\n"
      + "  pull_request:\n    paths:\n      - 'services/api/src/db/**'\n",
  );
  assert.ok(
    shapeRed(definedOnPush, '&ignore-db'),
    `锚点定义必须判「解析形态异常」并点名 &ignore-db，实测：${JSON.stringify(definedOnPush)}`,
  );
  assert.ok(
    !definedOnPush.some((problem) => problem.includes('永不触发') || problem.includes('没有覆盖')),
    `锚点问题不许被说成「被排除」或「没覆盖」：${JSON.stringify(definedOnPush)}`,
  );

  // ② 别名引用在 `pull_request.paths-ignore`（yaml 解析器里排除是**真的生效**的）。
  const aliasOnIgnore = armWith(
    "  push:\n    branches: [main]\n    paths:\n      - 'services/api/src/db/**'\n"
      + '  pull_request:\n    paths-ignore: *ignore-db\n',
  );
  assert.ok(
    shapeRed(aliasOnIgnore, '*ignore-db'),
    `别名引用必须判「解析形态异常」并点名 *ignore-db，实测：${JSON.stringify(aliasOnIgnore)}`,
  );
  assert.ok(
    !aliasOnIgnore.some((problem) => problem.includes('永不触发')),
    `别名问题不许被说成「被排除」：${JSON.stringify(aliasOnIgnore)}`,
  );

  // ③ `paths: &x [...]`：取值是行内序列但带锚点 ⇒ 同样看不见真实条目。
  const inlineAnchored = armWith(
    "  pull_request:\n    paths: &db-paths ['services/api/src/db/**']\n",
  );
  assert.ok(
    shapeRed(inlineAnchored, '&db-paths'),
    `\`paths: &x [...]\` 必须判「解析形态异常」并点名 &db-paths，实测：${JSON.stringify(inlineAnchored)}`,
  );

  // ④ 合并键 `<<:`：合并进来的条目本判据解析不到。
  const merged = armWith(
    "  pull_request:\n    <<: *defaults\n    paths:\n      - 'services/api/src/db/**'\n",
  );
  assert.ok(
    shapeRed(merged, '合并键'),
    `合并键必须判「解析形态异常」，实测：${JSON.stringify(merged)}`,
  );
  assert.ok(
    !merged.some((problem) => problem.includes('没有覆盖')),
    `合并键问题不许被说成「没覆盖」：${JSON.stringify(merged)}`,
  );
});

test('判据⑩ 不误伤：行内序列（含逗号后空格）、双引号、显式空数组都必须放行', () => {
  const db = { path: 'services/api/src/db', kind: 'dir' };
  const tail = 'jobs:\n  synthetic:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: node tests/integration/catalog-pg.mjs\n';
  const build = (body) => `name: ok arm\non:\n${body}${tail}`;

  // ① 逗号后带空格的行内序列：`unquote` 先 trim 再去引号，条目里不许留下引号（审查方 N1）。
  const spaced = build("  pull_request:\n    paths: ['services/api/src/db/**', 'tests/integration/catalog-pg.mjs']\n");
  assert.deepEqual(
    triggerPaths(spaced).pull_request,
    ['services/api/src/db/**', 'tests/integration/catalog-pg.mjs'],
    `逗号后带空格的行内序列被读错了：${JSON.stringify(triggerPaths(spaced).pull_request)}`,
  );
  const spacedProblems = triggerCoverageProblems(armRecordFrom({ file: 'ok-arm.yml', implPaths: [db] }, spaced));
  assert.deepEqual(spacedProblems, [], `合法行内序列不该被报红：${JSON.stringify(spacedProblems)}`);

  // ② 双引号同样放行。
  const doubled = build('  pull_request:\n    paths: ["services/api/src/db/**"]\n    paths-ignore: ["docs/**"]\n');
  assert.deepEqual(
    triggerCoverageProblems(armRecordFrom({ file: 'ok-arm.yml', implPaths: [db] }, doubled)),
    [],
    '双引号行内序列不该被报红',
  );

  // ③ 显式空数组 = 等于没写（审查方 N2）：解析成 null，且不参与覆盖/排除判定。
  const emptyArrays = build('  pull_request:\n    paths: []\n    paths-ignore: []\n');
  assert.equal(triggerPaths(emptyArrays).pull_request, null, '`paths: []` 应当解析成 null（等于没写）');
  assert.equal(triggerIgnorePaths(emptyArrays).pull_request, null, '`paths-ignore: []` 应当解析成 null');
  assert.deepEqual(
    triggerCoverageProblems(armRecordFrom({ file: 'ok-arm.yml', implPaths: [db] }, emptyArrays)),
    [],
    '`paths: []` / `paths-ignore: []` 不该被报红',
  );

  // ④ 块序列（今天的正常写法）同样放行。
  const block = build("  pull_request:\n    paths:\n      - 'services/api/src/db/**'\n");
  assert.deepEqual(
    triggerCoverageProblems(armRecordFrom({ file: 'ok-arm.yml', implPaths: [db] }, block)),
    [],
    '块序列不该被报红',
  );
});

test('判据⑩ 键名的写法 fail-closed：`"paths-ignore":` / `paths-ignore :` 都必须红并点名', () => {
  const db = { path: 'services/api/src/db', kind: 'dir' };
  const tail = 'jobs:\n  synthetic:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: node tests/integration/catalog-pg.mjs\n';
  const problemsOf = (body) =>
    triggerCoverageProblems(armRecordFrom({ file: 'key-shape-arm.yml', implPaths: [db] }, `name: key shape\non:\n${body}${tail}`));

  // ① 键名带双引号：`yaml@2.9.1` 照收不误（排除真的生效），只认裸键的行解析器会把整行跳过
  //    ⇒ 必须判「解析形态异常」并点名，不能静默当成「没有这个键」（审查方第五轮 B1''''）。
  const quotedIgnore = problemsOf('  pull_request:\n    "paths-ignore":\n      - \'services/api/src/db/**\'\n');
  assert.ok(
    quotedIgnore.some((problem) => problem.includes('解析形态异常') && problem.includes('键名写成了带引号')),
    `带引号的 \`"paths-ignore":\` 必须判「解析形态异常」并点名键名写法，实测：${JSON.stringify(quotedIgnore)}`,
  );
  assert.ok(
    !quotedIgnore.some((problem) => problem.includes('永不触发') || problem.includes('没有覆盖')),
    `键名写法问题不许被说成「被排除」或「没覆盖」：${JSON.stringify(quotedIgnore)}`,
  );

  // ② 冒号前有空格：同样是真的生效写法，同样必须点名。
  const spacedIgnore = problemsOf("  pull_request:\n    paths-ignore :\n      - 'services/api/src/db/**'\n");
  assert.ok(
    spacedIgnore.some((problem) => problem.includes('解析形态异常') && problem.includes('冒号之间有 1 个空格')),
    `\`paths-ignore :\` 必须判「解析形态异常」并点名冒号前空格，实测：${JSON.stringify(spacedIgnore)}`,
  );
  assert.ok(
    !spacedIgnore.some((problem) => problem.includes('永不触发')),
    `键名写法问题不许被说成「被排除」：${JSON.stringify(spacedIgnore)}`,
  );

  // ③ 覆盖侧的带引号 `"paths":` 也不能被当成「全量触发」放过去。
  const quotedPaths = problemsOf('  pull_request:\n    "paths":\n      - \'services/api/src/db/**\'\n');
  assert.ok(
    quotedPaths.some((problem) => problem.includes('解析形态异常') && problem.includes('键名写成了带引号')),
    `带引号的 \`"paths":\` 必须判「解析形态异常」，实测：${JSON.stringify(quotedPaths)}`,
  );
});

test('判据⑩ 键名不误伤：行尾注释、带注释的行内序列、裸键块序列都必须放行', () => {
  const db = { path: 'services/api/src/db', kind: 'dir' };
  const tail = 'jobs:\n  synthetic:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: node tests/integration/catalog-pg.mjs\n';
  const build = (body) => `name: key ok\non:\n${body}${tail}`;
  const problemsOf = (text) => triggerCoverageProblems(armRecordFrom({ file: 'key-ok.yml', implPaths: [db] }, text));

  // ① `paths-ignore:   # 行尾注释`：yaml 真值是 null（= 没有排除），不该判红（审查方第五轮 N-a）。
  const commentedEmpty = build('  pull_request:\n    paths-ignore:   # 行尾注释\n');
  assert.equal(
    triggerIgnorePaths(commentedEmpty).pull_request,
    null,
    '`paths-ignore:` 后只有行尾注释时应当解析成 null（等于没写）',
  );
  assert.deepEqual(problemsOf(commentedEmpty), [], `空值 + 行尾注释不该被报红：${JSON.stringify(problemsOf(commentedEmpty))}`);

  // ② 行内序列后面带注释：同样放行。
  const commentedInline = build("  pull_request:\n    paths: ['services/api/src/db/**'] # 收窄范围\n");
  assert.deepEqual(
    problemsOf(commentedInline),
    [],
    `行内序列后的行尾注释不该被报红：${JSON.stringify(problemsOf(commentedInline))}`,
  );

  // ③ 裸键块序列（上一轮 M7 钉住的正例）：不许因为本轮改动回退。
  const bareBlock = build("  pull_request:\n    paths:\n      - 'services/api/src/db/**'\n");
  assert.deepEqual(problemsOf(bareBlock), [], `裸键块序列不该被报红：${JSON.stringify(problemsOf(bareBlock))}`);
});

test('判据⑩ 不误伤：`on:` 下 `inputs:` / `with:` 里与 paths 同名的键是输入声明，不算触发面', () => {
  const db = { path: 'services/api/src/db', kind: 'dir' };
  const tail = 'jobs:\n  synthetic:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: node tests/integration/catalog-pg.mjs\n';
  const build = (body) => `name: inputs arm\non:\n${body}${tail}`;
  const problemsOf = (text) => triggerCoverageProblems(armRecordFrom({ file: 'inputs-arm.yml', implPaths: [db] }, text));

  // ① `workflow_call.inputs.paths`：yaml@2.9.1 的真值是 `{ paths: { type: string } }` —— 合法的
  //    可复用 workflow 入参，跟触发过滤毫无关系。误红会逼维护者去加白名单，所以按阻塞处理（第七轮 B1'''''）。
  const callInput = build(
    "  pull_request:\n    paths:\n      - 'services/api/src/db/**'\n"
      + '  workflow_call:\n    inputs:\n      paths:\n        type: string\n',
  );
  assert.deepEqual(
    problemsOf(callInput),
    [],
    `\`workflow_call.inputs.paths\` 是输入声明，不该被当成过滤键报红：${JSON.stringify(problemsOf(callInput))}`,
  );

  // ② `workflow_dispatch.inputs.paths` 同理（手动触发表单里的输入框）。
  const dispatchInput = build(
    "  pull_request:\n    paths:\n      - 'services/api/src/db/**'\n"
      + '  workflow_dispatch:\n    inputs:\n      paths:\n        description: 路径过滤\n        type: string\n',
  );
  assert.deepEqual(
    problemsOf(dispatchInput),
    [],
    `\`workflow_dispatch.inputs.paths\` 是输入声明，不该被报红：${JSON.stringify(problemsOf(dispatchInput))}`,
  );

  // ③ `with:` 之下同理（可复用 workflow 调用时的入参块）。
  const withScope = build(
    "  pull_request:\n    paths:\n      - 'services/api/src/db/**'\n"
      + '  workflow_call:\n    with:\n      paths:\n        type: string\n',
  );
  assert.deepEqual(problemsOf(withScope), [], `\`with.paths\` 是入参，不该被报红：${JSON.stringify(problemsOf(withScope))}`);

  // ④ 反空转：放行 `inputs:` 不等于把整个事件层一起跳过 —— 事件层的 paths 仍要真的解析到。
  assert.deepEqual(
    triggerPaths(callInput).pull_request,
    ['services/api/src/db/**'],
    `放行 \`inputs:\` 之后事件层的 paths 仍必须被解析到：${JSON.stringify(triggerPaths(callInput))}`,
  );
  assert.equal(
    triggerPaths(callInput).workflow_call,
    null,
    `\`inputs.paths\` 不该被记成 \`workflow_call.paths\`：${JSON.stringify(triggerPaths(callInput))}`,
  );
});

test('判据⑩ 显式键语法 / flow mapping 都 fail-closed，缩进 6 的直接子键仍红', () => {
  const db = { path: 'services/api/src/db', kind: 'dir' };
  const tail = 'jobs:\n  synthetic:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: node tests/integration/catalog-pg.mjs\n';
  const problemsOf = (body) =>
    triggerCoverageProblems(armRecordFrom({ file: 'shape-arm.yml', implPaths: [db] }, `name: shape\non:\n${body}${tail}`));

  // ① 显式键语法 `? paths-ignore` + `: [...]`：yaml 真值里排除照样生效，行解析器完全看不见（第七轮 N-a'）。
  const explicitKey = problemsOf("  pull_request:\n    ? paths-ignore\n    : ['services/api/src/db/**']\n");
  assert.ok(
    explicitKey.some((problem) => problem.includes('解析形态异常') && problem.includes('显式键语法')),
    `显式键语法必须判「解析形态异常」并点名：${JSON.stringify(explicitKey)}`,
  );
  assert.ok(
    !explicitKey.some((problem) => problem.includes('没有覆盖') || problem.includes('永不触发')),
    `显式键语法问题不许被说成「没覆盖」/「被排除」：${JSON.stringify(explicitKey)}`,
  );

  // ② 事件写成 flow mapping：今天只会「看不见过滤 ⇒ 当全量触发」，方向是漏判，所以按 fail-closed 判红，
  //    文案要说准「解析不到其触发过滤」（第七轮 N-c'）。
  const flowMap = problemsOf("  pull_request: {paths-ignore: ['services/api/src/db/**']}\n");
  assert.ok(
    flowMap.some((problem) => problem.includes('解析形态异常') && problem.includes('flow mapping')),
    `flow mapping 事件必须判「解析形态异常」并点名：${JSON.stringify(flowMap)}`,
  );

  // ③ N3：`pull_request` 的**直接**子键缩进 6 仍必须红 —— 别和 `inputs:` 下的同名键一起放过。
  const nestedIndent = problemsOf("  pull_request:\n      paths-ignore:\n        - 'services/api/src/db/**'\n");
  assert.ok(
    nestedIndent.some((problem) => problem.includes('解析形态异常') && problem.includes('缩进是 6 空格')),
    `\`pull_request\` 直接子键缩进 6 必须判红（N3）：${JSON.stringify(nestedIndent)}`,
  );
});

test('判据⑩ 白名单 fail-closed：块序列换行 / 事件 tag / 整段 on: flow / 别名条目都必须红并点名', () => {
  const db = { path: 'services/api/src/db', kind: 'dir' };
  const tail = 'jobs:\n  synthetic:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: node tests/integration/catalog-pg.mjs\n';
  const problemsOf = (body) =>
    triggerCoverageProblems(armRecordFrom({ file: 'whitelist-arm.yml', implPaths: [db] }, `name: whitelist\non:\n${body}${tail}`));
  const namesLine = (problems, needle) =>
    problems.some((problem) => problem.includes('解析形态不支持') && problem.includes(needle));

  // ① 第八轮 B1：块序列把值写在**下一行**（`-` 后面同行没值）。yaml@2.9.1 的真值是
  //    `["services/api/src/db/**"]`，排除真的生效；白名单只认「`-` 后面同行有值」，所以换行形态必须红。
  const nextLineValue = problemsOf("  pull_request:\n    paths-ignore:\n      -\n        'services/api/src/db/**'\n");
  assert.ok(
    nextLineValue.some((problem) => problem.includes('解析形态不支持（fail-closed）：- ')),
    `块序列把值写在下一行必须判红并点名「-」那一行，实测：${JSON.stringify(nextLineValue)}`,
  );

  // ② 第八轮 B2：事件键带 tag（`!!map`）。yaml 真值里 `paths-ignore` 照样生效，而白名单只认裸键事件。
  const tagged = problemsOf("  pull_request: !!map\n    paths-ignore: ['services/api/src/db/**']\n");
  assert.ok(
    namesLine(tagged, 'pull_request: !!map'),
    `事件键带 YAML tag 必须判红并点名该行，实测：${JSON.stringify(tagged)}`,
  );

  // ③ 整段 `on:` 写成 flow mapping：看不见里面任何触发过滤（文案限定在 `{…}` 形态）。
  const wholeOn = 'name: whitelist\non: {pull_request: {paths: [\'services/api/src/db/**\']}}\n' + tail;
  const wholeOnProblems = triggerShapeProblems(wholeOn);
  assert.ok(
    wholeOnProblems.some((problem) => problem.includes('flow mapping 能藏触发过滤')),
    `整段 \`on:\` 写成 flow mapping 必须判红，实测：${JSON.stringify(wholeOnProblems)}`,
  );

  // ③b `on:` 的**合法简写**必须放行（第十轮 B1：藏不进任何过滤层，误红会把维护者推去改错方向）：
  //    单事件标量（裸名 / 带双引号 / 带单引号）、行内事件列表（元素可裸可带引号、可混排）。
  //    第十一轮 B1 补的是「引号」这一族：`on: "push"` 原来被判红，而 `on: ["push"]` 却是绿的。
  const allowedOnLines = [
    'on: push',
    'on: "push"',
    "on: 'pull_request'",
    'on: [push, pull_request]',
    'on: ["push","pull_request"]',
    "on: ['push', 'pull_request']",
    'on: ["push", \'pull_request\']',
    'on: push  # 只跑 push',
  ];
  for (const shorthand of allowedOnLines) {
    const problems = triggerShapeProblems(
      `name: shorthand\n${shorthand}\njobs:\n  synthetic:\n    runs-on: ubuntu-24.04\n`,
    );
    assert.deepEqual(problems, [], `\`${shorthand}\` 是合法写法（没有过滤层），不该被判红：${JSON.stringify(problems)}`);
  }

  // ③c 放行不等于无脑放行：本判据不认识的 `on:` 写法必须红，且文案不能再说成「flow mapping」。
  for (const unknownOn of [
    'on: unknown_but_looks_like_scalar?',
    'on: [push, pull_request',
    'on: !!str push',
  ]) {
    const problems = triggerShapeProblems(
      `name: unknown\n${unknownOn}\njobs:\n  synthetic:\n    runs-on: ubuntu-24.04\n`,
    );
    assert.ok(
      problems.some((problem) => problem.includes('不认识的 `on:` 写法')),
      `\`${unknownOn}\` 不属于放行形态，必须判红并点名「不认识的 on: 写法」：${JSON.stringify(problems)}`,
    );
    assert.ok(
      !problems.some((problem) => problem.includes('flow mapping')),
      `\`${unknownOn}\` 不是 flow mapping，文案不许混成 flow mapping：${JSON.stringify(problems)}`,
    );
  }

  // ④ 块序列条目用别名引用：真实条目在锚点那头，行解析器看不见。
  const aliasItem = problemsOf("  pull_request:\n    paths-ignore:\n      - *db-paths\n");
  assert.ok(
    aliasItem.some((problem) => problem.includes('别名引用')),
    `块序列条目用别名必须判红并点名，实测：${JSON.stringify(aliasItem)}`,
  );

  // ⑤ 白名单内的合法写法不许被误伤：不含 paths 的事件 flow mapping、4 空格 `- cron:` 条目、
  //    `    branches: [main]` 这类过滤层键都要放行。
  const legal = triggerShapeProblems(
    'name: whitelist\non:\n  push:\n    branches: [main]\n  schedule:\n    - cron: \'0 3 * * *\'\n'
      + '  pull_request: {types: [opened]}\njobs:\n  synthetic:\n    runs-on: ubuntu-24.04\n',
  );
  assert.deepEqual(legal, [], `白名单内的合法写法不该被报红：${JSON.stringify(legal)}`);
});

test('判据⑩ 白名单不误伤仓内现有 workflow：`.github/workflows/*.yml` 全部过一遍', () => {
  const files = allWorkflowFiles();
  assert.ok(files.length >= 5, `白名单自查至少要扫到 5 份 workflow，实测 ${files.length} 份`);
  const offenders = [];
  for (const file of files) {
    for (const problem of triggerShapeProblems(readWorkflow(file))) offenders.push(`${file}：${problem}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `判据⑩ 的白名单把仓库现有 workflow 判红了（合入即红在别人身上）：${JSON.stringify(offenders, null, 1)}`,
  );
});

test('判据⑩ 块序列条目的缩进相对所属键：`paths-ignore` / `paths` 下的 4/5/6/7/8 空格都必须被解析出来', () => {
  // 第九轮审查方实测的假绿：白名单允许 4–6 空格条目，而解析器只认 6 空格 ⇒ 4/5 空格的
  // `paths-ignore` 条目读不到（=「没有排除」）、`paths` 条目也读不到（=「没有过滤 ⇒ 全量触发」），
  // 于是注入真 catalog 后 EXIT=0、全绿。这里用内存文本把 5 种缩进一次性钉住：
  // 排除侧必须红、收窄侧必须红、真覆盖侧必须放行（既不能漏判，也不能误红）。
  const armText = ({ key, indent, entry }) => [
    'name: synthetic-indent-arm',
    'on:',
    '  pull_request:',
    '  push:',
    '    branches: [main]',
    `    ${key}:`,
    `${' '.repeat(indent)}- '${entry}'`,
    'jobs:',
    '  synthetic:',
    '    runs-on: ubuntu-24.04',
    '',
  ].join('\n');
  const dbDir = [{ path: 'services/api/src/db', kind: 'dir' }];
  const readings = [];
  for (const indent of [4, 5, 6, 7, 8]) {
    // ① 排除侧：真把被测实现目录排掉了 ⇒ 必须红并点名「永不触发」
    const ignoreRecord = armRecordFrom(
      { file: `synthetic-ignore-${indent}.yml`, implPaths: dbDir },
      armText({ key: 'paths-ignore', indent, entry: 'services/api/src/db/**' }),
    );
    assert.deepEqual(
      ignoreRecord.ignore.push,
      ['services/api/src/db/**'],
      `缩进 ${indent} 的 paths-ignore 条目没被解析出来（读成「没有排除」就是假绿）`,
    );
    const ignoreProblems = triggerCoverageProblems(ignoreRecord);
    assert.ok(
      ignoreProblems.some((problem) => problem.includes('paths-ignore') && problem.includes('永不触发')),
      `缩进 ${indent} 的 paths-ignore 排掉实现目录必须红并点名：${JSON.stringify(ignoreProblems)}`,
    );
    // ② 收窄侧：paths 只留 docs/** ⇒ 不覆盖实现目录，必须红（读成「没有 paths」就会被当成全量触发放行）
    const narrowRecord = armRecordFrom(
      { file: `synthetic-paths-${indent}.yml`, implPaths: dbDir },
      armText({ key: 'paths', indent, entry: 'docs/**' }),
    );
    assert.deepEqual(narrowRecord.paths.push, ['docs/**'], `缩进 ${indent} 的 paths 条目没被解析出来`);
    assert.ok(
      triggerCoverageProblems(narrowRecord).some((problem) => problem.includes('on.push.paths') && problem.includes('没有覆盖')),
      `缩进 ${indent} 的 paths 收窄后必须点名「没有覆盖」`,
    );
    // ③ 覆盖侧：真列了实现目录 ⇒ 必须放行（误红同样是缺陷）
    const okRecord = armRecordFrom(
      { file: `synthetic-paths-ok-${indent}.yml`, implPaths: dbDir },
      armText({ key: 'paths', indent, entry: 'services/api/src/db/**' }),
    );
    assert.deepEqual(
      triggerCoverageProblems(okRecord),
      [],
      `缩进 ${indent} 的 paths 已经覆盖实现目录，不该报红：${JSON.stringify(triggerCoverageProblems(okRecord))}`,
    );
    readings.push(`${indent} 空格=红(排除)/红(收窄)/绿(覆盖)`);
  }
  console.log(`[判据⑩ 读数] 条目缩进矩阵（相对键缩进）：${readings.join('、')}`);
});

test('判据⑩ 条目判定只有一份口径：`blockItemValue()` 按相对键缩进收条目，`-` 后无值一律不收', () => {
  for (const indent of [4, 5, 6, 7, 8]) {
    assert.strictEqual(
      blockItemValue(`${' '.repeat(indent)}- 'services/api/src/db/**'`, 4),
      "'services/api/src/db/**'",
      `缩进 ${indent}（≥ 键缩进 4）必须算这条键的条目`,
    );
  }
  assert.strictEqual(blockItemValue("  - 'x'", 4), null, '比键更浅的缩进不是这条键的条目');
  assert.strictEqual(blockItemValue(`${' '.repeat(6)}-`, 4), null, '`-` 后面没有值不算条目（值写在下一行仍判红）');
  assert.strictEqual(blockItemValue(`${' '.repeat(6)}-   `, 4), null, '`-` 后面只有空白也不算条目');
  // 白名单 ④ 与解析器共用这一个函数：`schedule:` 的 4 空格 `- cron:` 必须被放行
  const schedule = triggerShapeProblems(
    "name: s\non:\n  schedule:\n    - cron: '0 3 * * *'\njobs:\n  a:\n    runs-on: ubuntu-24.04\n",
  );
  assert.deepEqual(schedule, [], `schedule 的 4 空格条目被误红：${JSON.stringify(schedule)}`);
});

test('判据⑩ 块序列条目之间的空行不截断解析：空行后面的条目仍要算进去', () => {
  // 第九轮把解析器里的 `break` 改成「空行/注释行 continue」，否则 `paths:` 中间空一行就会
  // 只读到一半条目 —— 后面的 `services/api/src/db/**` 被吞掉，真覆盖被读成「没覆盖」。
  // （注释行本来就被 `stripCommentLines()` 先删掉，这一条真正钉住的是**空行**。）
  const text = [
    'name: synthetic-blank-line',
    'on:',
    '  pull_request:',
    '  push:',
    '    branches: [main]',
    '    paths:',
    "      - 'docs/**'",
    '',
    "      - 'services/api/src/db/**'",
    'jobs:',
    '  synthetic:',
    '    runs-on: ubuntu-24.04',
    '',
  ].join('\n');
  const record = armRecordFrom(
    { file: 'synthetic-blank-line.yml', implPaths: [{ path: 'services/api/src/db', kind: 'dir' }] },
    text,
  );
  assert.deepEqual(
    record.paths.push,
    ['docs/**', 'services/api/src/db/**'],
    `空行后面的条目必须仍然被解析（否则「真覆盖」被读成「没覆盖」）：${JSON.stringify(record.paths)}`,
  );
  assert.deepEqual(
    triggerCoverageProblems(record),
    [],
    `两条条目合起来已经覆盖实现目录，不该红：${JSON.stringify(triggerCoverageProblems(record))}`,
  );
});

test('判据⑩ `inputs:` 域的复位行不能把后面的红吞掉：出域之后的事件层引号键必须仍被判红', () => {
  // 删掉 `if (nested && 缩进 <= 4) nested = false;` 这一行时，nested 会一直停在 true，
  // `nearMissProblem()` 于是对出域后的过滤键直接返回 null ⇒ 只剩一条笼统的「on: 段只接受…」。
  const afterInputs = triggerShapeProblems([
    'name: nested-reset',
    'on:',
    '  workflow_call:',
    '    inputs:',
    '      paths:',
    '        description: 输入声明的同名键',
    '  pull_request:',
    "    \"paths-ignore\": ['services/api/src/db/**']",
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-24.04',
    '',
  ].join('\n'));
  assert.ok(
    afterInputs.some((problem) => problem.includes('键名写成了带引号的形式')),
    `inputs: 域之后的引号键必须被识破（说明 nested 已复位）：${JSON.stringify(afterInputs)}`,
  );
  assert.ok(
    !afterInputs.some((problem) => problem.includes('on: 段只接受')),
    `不该再落到笼统的「白名单」消息上：${JSON.stringify(afterInputs)}`,
  );
});
