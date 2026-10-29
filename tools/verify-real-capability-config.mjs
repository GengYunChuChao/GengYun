#!/usr/bin/env node
/**
 * 耕云 · 真实能力配置自检（GY-R69）。
 *
 * `npm run verify:real-capability [-- --json] [--strict] [--require=asr,chat-llm]`
 *
 * 回答一个问题：**按能力组看，真实 AI / 真实媒体链路的配置到底齐不齐？**
 * 只读**进程环境**：不读 `.env`、不读任何凭据文件、不联网、不落盘。
 *
 * 为什么需要它：`real` 模式的启动必填只有 9 项，而 `MEDIA_OBJECT_REF_KEY`、
 * `MEDIA_ACCESS_GRANT_ORIGIN`、`CHAT_LLM_*`、`RECOGNITION_PROVIDER_*` 这四组
 * **不参与启动校验**——缺了服务照样起得来，只是媒体域整域 503、语音受理 409、
 * 问答退回确定性摘录、识别受理 503。于是「起得来」被误当成「能力齐」。
 *
 * 本文件只做**入口**：`process.env` 在这里读一次，之后全是
 * `tools/lib/real-capability-config.mjs` 的纯函数。测试直接调 `runCli({ argv, env })`
 * 注入环境与输出收集器，因此不依赖也不污染真环境。
 *
 * 泄密红线（结构上保证，不靠自觉）：
 *   ⛔ 不输出任何字段值、不输出前缀、不输出后 4 位、不输出长度数字；
 *   逐字段只出 `present`／`missing` 与「形态规则过没过」的布尔。
 */
import { pathToFileURL } from 'node:url';
import {
  EXIT_USAGE,
  USAGE,
  evaluateCapabilityConfig,
  exitCodeFor,
  parseCliArgs,
  renderHuman,
  renderJson,
} from './lib/real-capability-config.mjs';

export { EXIT_OK, EXIT_STRICT_FAILURE, EXIT_USAGE } from './lib/real-capability-config.mjs';
export {
  CAPABILITY_GROUPS,
  GROUP_IDS,
  evaluateCapabilityConfig,
  parseCliArgs,
  renderHuman,
  renderJson,
  exitCodeFor,
} from './lib/real-capability-config.mjs';

/**
 * CLI 执行体（`node tools/verify-real-capability-config.mjs` 走的就是这一条）。
 *
 * @param {{ argv?: string[], env?: Record<string, string | undefined>,
 *           stdout?: (text: string) => void, stderr?: (text: string) => void }} [options]
 * @returns {number} 退出码：0 自检通过（默认恒 0）｜1 `--strict` 判定 FAIL｜2 用法错误
 */
export function runCli({ argv = [], env = {}, stdout = () => {}, stderr = () => {} } = {}) {
  const parsed = parseCliArgs(argv);

  if (parsed.errors.length > 0) {
    // ⚠ 只回显参数（用户自己敲的），绝不回显环境值；也不回显任何异常文本。
    for (const error of parsed.errors) stderr(`用法错误：${error}\n`);
    stderr(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (parsed.help) {
    stdout(`${USAGE}\n`);
    return 0;
  }

  // ⛔ 只在 try 里调用：真出错时也不把异常里可能带的值打出去。
  let report;
  try {
    report = evaluateCapabilityConfig({
      env,
      requiredGroups: parsed.require.length > 0 ? parsed.require : undefined,
      strict: parsed.strict,
    });
  } catch {
    stderr('自检未能完成：内部错误（错误详情不打印，以免带出配置值）。\n');
    return EXIT_USAGE;
  }

  stdout(parsed.json ? renderJson(report) : renderHuman(report));
  return exitCodeFor(report);
}

/** 入口判定：被 `node` 直接执行才算 CLI（被 `import` 时不动 `process.exitCode`）。 */
function invokedDirectly() {
  const entry = process.argv[1];
  return typeof entry === 'string' && entry !== '' && import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  // ⚠ 全仓**唯一**读 `process.env` 的地方：读一次，传下去。
  process.exitCode = runCli({
    argv: process.argv.slice(2),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
