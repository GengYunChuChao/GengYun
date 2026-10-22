#!/usr/bin/env node
// live 适配器输出 → predictions 文件的本机采集骨架（issue #21「有评估无门槛」：`packages/evaluation` 对
// `services/` 零引用，没有 live→predictions 的采集桥，门槛再全也拿不到读数）。
//
// 本工具**自己不做任何网络/供应商调用**，也不会替真实调用伪造输出。默认 `--dry-run`：
// 只打印"会采哪个 task、写到哪个文件"，不联网、不写盘、不花钱。
//
// 准入规则（未授权必须**主动拒绝**，不许静默降级成 dry-run —— 静默降级会让人以为采过数据）：
//   · 出现任何供应商调用开关（--live/--provider/--endpoint/--model/--call/--invoke）而没有
//     --confirm-paid-calls ⇒ 中文原因 + exit 2；
//   · 带了 --confirm-paid-calls 但本片未实现真实调用 ⇒ 中文原因 + exit 3（明确"未实现"，
//     绝不用空文件冒充采集结果）；
//   · --from-file <raw.json> ⇒ 唯一可用的离线路径：格式校验 + 落盘，供离线测试与人工粘贴真实输出。
//
// 用法：
//   node tools/evaluation/collect-predictions.mjs [--task <task>] [--out <path>] [--index <index.json>]   # 默认 dry-run
//   node tools/evaluation/collect-predictions.mjs --from-file <raw.json> --task <task> --out <path>
//   node tools/evaluation/collect-predictions.mjs --live --task <task> --confirm-paid-calls --out <path>
// 退出码：0 成功 / 2 未授权（拒绝执行）/ 3 已授权但功能未实现 / 4 参数或输入格式错误。
//
// 密钥纪律：本工具**不接收密钥**；带 --api-key/--token/--secret 之类参数会被直接拒绝且不回显取值。
// 真实凭据只应从运行环境读取，且永不写入仓库（AGENTS.md「数据与执行」）。

import { writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stderr, stdout } from 'node:process';
import { parseArgs, loadJson, toPredictionMap } from './lib.mjs';
import { SCORERS, validatePredictionOutput } from '../../packages/evaluation/index.mjs';

export const EXIT = { OK: 0, REFUSED: 2, UNIMPLEMENTED: 3, USAGE: 4 };
export const AUTHORIZATION_FLAG = 'confirm-paid-calls';
/** 任何"会打到供应商"的开关：未授权时一律拒绝，不做降级。 */
export const SUPPLIER_FLAGS = ['live', 'provider', 'endpoint', 'model', 'call', 'invoke'];
/** 绝不接收的参数：命中即拒绝（且不回显取值）。 */
export const SECRET_FLAGS = ['api-key', 'apikey', 'api_key', 'token', 'secret', 'key', 'authorization'];

export const TASKS = Object.keys(SCORERS);

const say = (stream, text) => stream.write(`${text}\n`);

/** 命中密钥类参数 ⇒ 拒绝（只报参数名，不回显取值）。返回 null 表示可以继续。 */
export function checkSecretArgs(args) {
  const hit = SECRET_FLAGS.filter((flag) => args[flag] !== undefined);
  if (hit.length === 0) return null;
  return {
    code: EXIT.REFUSED,
    reason: `拒绝执行：本工具不接收也不记录密钥／令牌（命中参数 ${hit.map((f) => `--${f}`).join('、')}）。`
      + '凭据只应留在运行环境，且不得写入仓库；如需带凭据的真实调用，请由已授权的服务侧执行并把输出用 --from-file 交进来。',
  };
}

/** live 授权闸门：未授权一律拒绝（exit 2）；已授权但未实现（exit 3）。返回 null 表示可继续。 */
export function checkLiveAuthorization(args) {
  const supplierRequested = SUPPLIER_FLAGS.filter((flag) => args[flag] !== undefined);
  if (supplierRequested.length === 0) return null;
  if (args[AUTHORIZATION_FLAG] !== true) {
    return {
      code: EXIT.REFUSED,
      reason: `拒绝执行：检测到供应商调用开关（${supplierRequested.map((f) => `--${f}`).join('、')}），但未带授权开关 --${AUTHORIZATION_FLAG}。`
        + '本项目默认不联网、不发起任何付费模型调用（AGENTS.md「数据与执行」：新增付费验证需用户单独授权）。'
        + '如需真实采集：先取得用户对具体供应商/预算的授权，再带 --' + AUTHORIZATION_FLAG + ' 重跑；'
        + '离线核对格式请改用 --from-file <raw.json>。',
    };
  }
  return {
    code: EXIT.UNIMPLEMENTED,
    reason: `已带授权开关 --${AUTHORIZATION_FLAG}，但本片只交采集骨架，**未实现**任何供应商调用（无适配器、无重试、无计费保护）。`
      + '不会写入空文件或伪造预测来冒充采集结果。真实调用应由服务侧适配器完成，输出用 --from-file 交回本工具做格式校验与落盘。',
  };
}

/** 规范化 predictions 落盘内容：{ "<sampleId>": output }，按 sampleId 排序，便于 diff 与逐字节复算。 */
export function canonicalPredictions(map) {
  const sorted = [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`;
}

/**
 * 离线路径：读 raw 适配器输出 → 逐条格式校验 → 写成 predictions 文件。
 * 校验口径直接复用评分侧 `validatePredictionOutput`（服务失败/缺字段/校正稿冒充等一律拒收），
 * 避免"采集端放行、评分端全丢"的错配。任一条不合法 ⇒ 整批不落盘（不做部分写入）。
 */
export function collectFromFile({ file, task, out }) {
  if (!TASKS.includes(task)) throw Object.assign(new Error(`未知 task=${task}（可选：${TASKS.join('、')}）`), { code: EXIT.USAGE });
  const map = toPredictionMap(loadJson(file));
  const invalid = [];
  for (const [sampleId, output] of map) {
    const verdict = validatePredictionOutput(task, output);
    if (!verdict.ok) invalid.push(`${sampleId}: ${verdict.reason}`);
  }
  if (invalid.length > 0) {
    const shown = invalid.slice(0, 10).join('\n  ');
    const more = invalid.length > 10 ? `\n  …另有 ${invalid.length - 10} 条` : '';
    throw Object.assign(
      new Error(`拒绝落盘：${invalid.length}/${map.size} 条预测不符合 ${task} 的评分口径（采集端不得把不可评分输出交出去）\n  ${shown}${more}`),
      { code: EXIT.USAGE },
    );
  }
  if (map.size === 0) throw Object.assign(new Error('拒绝落盘：预测为空（空文件会被当成"采过数据"，评分侧应看到明确缺失）'), { code: EXIT.USAGE });
  const payload = canonicalPredictions(map);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, payload, 'utf8');
  return { count: map.size, out, sha256: createHash('sha256').update(payload).digest('hex'), task };
}

/** dry-run：不联网、不写盘，只说明"如果要采，采什么、写哪里"。 */
export function describeDryRun({ task, out, index }) {
  const lines = ['[dry-run] 未联网、未写入任何文件（默认行为）。'];
  lines.push(`目标 task：${task}${TASKS.includes(task) ? '' : `（注意：不在可选列表 ${TASKS.join('、')} 内）`}`);
  lines.push(`计划输出：${out}`);
  if (index) {
    const records = loadJson(index);
    const test = (Array.isArray(records) ? records : []).filter((r) => r && r.split === 'test' && r.task === task);
    lines.push(`索引 ${index}：task=${task} 的 test 样本 ${test.length} 条（采集应以这 ${test.length} 条为分母）`);
  } else {
    lines.push('未给 --index：不知道分母有多少条；正式采集请带 --index 以便按 test 划分对齐。');
  }
  lines.push('真实调用需要：用户对供应商/预算的单独授权 + --' + AUTHORIZATION_FLAG + '（本片未实现调用，会以 exit 3 明确拒绝）。');
  lines.push('离线路径：--from-file <raw.json> --task <task> --out <predictions.json>（格式校验后落盘）。');
  return lines;
}

const USAGE = [
  '用法：',
  '  node tools/evaluation/collect-predictions.mjs [--task <task>] [--out <path>] [--index <index.json>]   # 默认 dry-run',
  '  node tools/evaluation/collect-predictions.mjs --from-file <raw.json> --task <task> --out <predictions.json>',
  '  node tools/evaluation/collect-predictions.mjs --live --task <task> --confirm-paid-calls --out <path>  # 本片未实现：exit 3',
  `退出码：0 成功 / 2 未授权（拒绝执行）/ 3 已授权但未实现 / 4 参数或输入格式错误。可选 task：${TASKS.join('、')}`,
].join('\n');

function main(argv) {
  const args = parseArgs(argv);
  if (args.help === true) {
    say(stdout, USAGE);
    return EXIT.OK;
  }

  const secret = checkSecretArgs(args);
  if (secret) {
    say(stderr, secret.reason);
    return secret.code;
  }

  if (args['from-file'] !== undefined && SUPPLIER_FLAGS.some((flag) => args[flag] !== undefined)) {
    say(stderr, '拒绝执行：--from-file（离线校验）与供应商调用开关互斥，避免"以为在离线校验、其实发了请求"。');
    return EXIT.USAGE;
  }

  const live = checkLiveAuthorization(args);
  if (live) {
    say(stderr, live.reason);
    return live.code;
  }

  const task = typeof args.task === 'string' ? args.task : 'weed_photo';
  const out = typeof args.out === 'string' ? args.out : resolve(`${task}.predictions.json`);

  if (args['from-file'] !== undefined) {
    if (typeof args['from-file'] !== 'string') {
      say(stderr, '用法：--from-file 需要给出 raw 适配器输出文件路径。');
      return EXIT.USAGE;
    }
    if (typeof args.out !== 'string') {
      say(stderr, '用法：--from-file 必须显式给 --out（避免误写进仓库工作区）。');
      return EXIT.USAGE;
    }
    try {
      const result = collectFromFile({ file: args['from-file'], task, out: args.out });
      say(stdout, `已写入 ${result.out}：${result.count} 条 task=${result.task} 预测，sha256=${result.sha256}`);
      say(stdout, '下一步：node tools/evaluation/run-evaluation.mjs --index <index.json> --predictions <该文件>');
      return EXIT.OK;
    } catch (error) {
      say(stderr, error.message);
      return error.code ?? EXIT.USAGE;
    }
  }

  for (const line of describeDryRun({ task, out, index: typeof args.index === 'string' ? args.index : null })) say(stdout, line);
  return EXIT.OK;
}

// 仅在作为脚本直接执行时进入 CLI；被测试 import 时不得触发 main（否则会解析测试进程 argv 并退出）。
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exitCode = main(process.argv.slice(2));

export { main };
