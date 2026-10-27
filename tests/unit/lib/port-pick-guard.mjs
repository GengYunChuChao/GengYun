/**
 * 「自起 PG 集群的脚本怎么挑端口」判据本体（纯文本，零依赖）。
 *
 * 单独放一个模块（不是测试文件）是为了让**同一条判据**既能被 `tests/unit/ci-integration-port-picking.test.mjs`
 * 跑在真实目录上，也能被取证脚本跑在任意快照目录上（例如 `git archive` 出来的改造前快照），
 * 避免「守卫是绿的，但取证用的是另一份手写正则」这种自欺。
 *
 * 背景（真实事故）：C05 的 CI 首跑，`real-pg-17.11` job 红在
 * `could not bind IPv4 address "127.0.0.1": Address already in use` /
 * `FATAL:  could not create any TCP/IP sockets`。根因是脚本用 `55500 + randomInt(0, 500)` 挑端口，
 * 而 Linux 默认 ephemeral 区间是 **32768–60999**，runner 上任何出站连接的源端口都可能占住它。
 *
 * @module tests/unit/lib/port-pick-guard
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DEFAULT_INTEGRATION_DIR = join(REPO_ROOT, 'tests', 'integration');

/** 共用挑端口工具（自起集群的脚本必须 import 它）。 */
export const FREE_PORT_IMPORT = './lib/free-port.mjs';

/** 「真的会起集群」的文本判据：单引号的二进制名（`knowledge-native-pg.ps1` 用 `'initdb.exe'`，不算）。 */
export const CLUSTER_MARKER = /'(initdb|pg_ctl)'/;

/**
 * 违规判据 A：固定基址 + 随机偏移。基址限定在 **Linux ephemeral 区间 32768–60999** 内 —— 这正是事故的形状。
 * 区间外的常量（例如既有实例 5432）不归本判据管。
 */
export const CONST_BASE_PLUS_RANDOM
  = /(?:^|[^\w.])(?:3[2-9]\d{3}|[4-6]\d{4})\s*\+\s*(?:randomInt\s*\(|Math\.floor\s*\(\s*Math\.random)/;

/**
 * 违规判据 B：从固定基址开始**顺序扫**（`for (let candidate = 55436; …)`）。顺序扫同样把候选锁在
 * ephemeral 区间里，只是撞上的概率形状不同——根因一致。
 */
export const FIXED_RANGE_SCAN = /for\s*\(\s*let\s+\w+\s*=\s*(?:3[2-9]\d{3}|[4-6]\d{4})\s*;/;

/**
 * 违规判据 C：把端口**直接写死**成 ephemeral 区间里的常量（`port = 55488;`、`const boundPort = 55488;`）。
 * 不随机也一样会撞：那个号随时可能被出站连接占住；同机并行跑两条还会互撞。
 *
 * 名字放宽成「任意含 `port` 的标识符」、且**不要求分号/行尾收尾**：审查方三个变异
 * （`const boundPort = 55488;` / `port = 55488 // 兜底` / `const port2 = 55488;`）就是靠改名、
 * 靠行尾注释绕过早期的 `(?:port|pgPort|portNumber|candidate)…(?:[;,)]|$)` 收窄版的。
 */
export const FIXED_PORT_LITERAL
  = /\b\w*(?:[Pp]ort|PORT)\w*\s*=\s*(?:3[2-9]\d{3}|[4-6]\d{4})\b/;

/**
 * 违规判据 D：**必须真把工具返回值用掉**。
 *
 * 「import 了、也调了、结果丢地上，然后自己写死一个端口」在文本上和正常用法几乎一样，只有看
 * 「有没有把 `pickFreePort()` 的结果赋出去/返回出去」才抓得住。三种真实写法都认：
 * `const port = await pickFreePort()`、`candidate = await pickFreePort()`（循环内换候选）、
 * `return pickFreePort()` / `return await pickFreePort()`（包装成局部 `pickPort()` 的臂）。
 */
export const USES_PORT_PICK = /= *await pickFreePort\(\)|return\s+(?:await\s+)?pickFreePort\(\)/;

/**
 * 注释行：`//`、块注释续行 `*`、块注释起始 `/*`。整行先剔除再匹配。
 *
 * 为什么必须剔：改造后的脚本会在注释里写「⛔ 原先是 `55500 + randomInt(0, 500)`」——那是解释
 * **为什么不再这么干**的证据，不是违规代码；不剔就会把说明文字判成违规（假红）。
 */
export const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

export function isCommentLine(line) {
  return COMMENT_LINE.test(line);
}

/** 单行是否违规（`null` = 放行）。给合成样本做正/负控制用，与主扫描**同一套**判据。 */
export function lineViolates(line) {
  if (isCommentLine(line)) return null;
  if (CONST_BASE_PLUS_RANDOM.test(line)) return '常量基址 + randomInt/Math.random';
  if (FIXED_RANGE_SCAN.test(line)) return '固定基址顺序扫区间';
  if (FIXED_PORT_LITERAL.test(line)) return '端口写死成固定常量';
  return null;
}

/**
 * 判一个 `(文件名, 源码文本)`：给目录扫描用，也给测试做**内存注入**（不落盘就能造变异）。
 *
 * @param {string} file 文件名（只用于报错点名）
 * @param {string} text 源码全文
 * @returns {{file: string, isCluster: boolean, violations: {file: string, line: number, text: string, rule: string}[], importsTool: boolean, usesTool: boolean}}
 */
export function inspectSource(file, text) {
  const violations = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rule = lineViolates(lines[index]);
    if (rule === null) continue;
    violations.push({ file, line: index + 1, text: lines[index].trim(), rule });
  }
  return {
    file,
    isCluster: CLUSTER_MARKER.test(text),
    violations,
    importsTool: text.includes(FREE_PORT_IMPORT),
    usesTool: USES_PORT_PICK.test(text),
  };
}

/**
 * 扫一个目录（**非递归**，只 `*.mjs`）。
 * @param {string} [dir] 目录，默认 `tests/integration`
 * @returns {{dir: string, files: string[], clusterScripts: string[], hits: {file: string, line: number, text: string, rule: string}[], missingToolImport: string[], missingToolUse: string[]}}
 */
export function scanPortPicking(dir = DEFAULT_INTEGRATION_DIR) {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))
    .map(entry => entry.name)
    .sort();

  const clusterScripts = [];
  const hits = [];
  const missingToolImport = [];
  const missingToolUse = [];

  for (const file of files) {
    const report = inspectSource(file, readFileSync(join(dir, file), 'utf8'));
    if (!report.isCluster) continue;
    clusterScripts.push(file);
    if (!report.importsTool) missingToolImport.push(file);
    if (!report.usesTool) missingToolUse.push(file);
    hits.push(...report.violations);
  }

  return { dir, files, clusterScripts, hits, missingToolImport, missingToolUse };
}
