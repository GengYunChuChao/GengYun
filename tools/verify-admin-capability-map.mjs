#!/usr/bin/env node
/**
 * 后台能力图闸门 CLI：重算 `docs/architecture/admin-console-capability-map.md` 里的读数，并**整块**比对标记块。
 *
 * 比对范围：`--check` 比的是**整个标记块**（`begin…end`，含前言段、读数表、逐 operation 表、族表），
 * 统一行尾与前后空白后逐字节比对——不相等即 exit 1，并打印第一处差异（文档行号 + 两边原文）。
 * 只比读数表不够：逐 op 表里的「说明」、族表里的视图并集同样是重算值，被手改成
 * 「已有 UI 入口」这类假话时，若只比读数就仍然全绿——那正是本片要消灭的假绿通道。
 *
 * `noUiEntry` 只是**缺口下界**（见 `tools/lib/admin-capability-map.mjs` 头注释第 3 条）：
 * 死代码里调过一次也算入口，所以 `noUiEntry === 0` 不等于「能力齐」。
 *
 * 用法：
 *   node tools/verify-admin-capability-map.mjs                 # 打印判定表 + 汇总，并比对文档标记块
 *   node tools/verify-admin-capability-map.mjs --check         # 只比对（CI 用），不一致 exit 1
 *   node tools/verify-admin-capability-map.mjs --update        # 只重写标记块内的数字（散文不动）
 *   node tools/verify-admin-capability-map.mjs --root <目录>   # 指向夹具树（单测/负例用）
 *
 * 为什么要有这道闸门：这份能力页的两句读数（「12 个后端有面、UI 无入口」「`apps/admin/src`
 * 全树对 `/admin/registrations` 的引用数为 0」）被代码证伪后一直没人发现——散文读数没有可证伪的
 * 出口。现在块内数字由源码重算、CI 逐项比对，腐烂会当场变红。
 *
 * 退出码：0 = 文档与重算一致；1 = 不一致 / 解析失败 / 标记块缺失。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AdminCapabilityMapError,
  DOC_BEGIN,
  DOC_END,
  SOURCE_PATHS,
  assertNonVacuous,
  buildCapabilityMap,
  compareDocBlock,
  compareReadings,
  loadSources,
  parseDocBlock,
  renderDocBlock,
  renderSummaryLine,
  renderTable,
} from './lib/admin-capability-map.mjs';

/** 仓库根：由脚本位置推出（`tools/` → `..`），⛔ 不用 `process.cwd()`。 */
export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = [
  '用法：node tools/verify-admin-capability-map.mjs [--check|--update] [--root <目录>]',
  '',
  '  （无参数）  打印判定表 + 汇总，并比对文档标记块（不一致 exit 1）',
  '  --check     只比对文档标记块（CI 用），不一致 exit 1',
  '  --update    只重写标记块内的数字/名单，块外散文不动',
  '  --root <目录>  指向夹具树（默认本脚本所在的仓库根）',
].join('\n');

/** 解析参数；未知参数直接抛错（不静默忽略）。 */
export function parseArgs(argv) {
  const options = { mode: 'print', root: TOOL_ROOT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.mode = 'check';
    else if (arg === '--update') options.mode = 'update';
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) throw new AdminCapabilityMapError('--root 需要一个目录参数');
      options.root = resolve(value);
      i += 1;
    } else if (arg.startsWith('--root=')) {
      options.root = resolve(arg.slice('--root='.length));
    } else {
      throw new AdminCapabilityMapError(`未知参数：${arg}`);
    }
  }
  return options;
}

/**
 * 主流程。返回退出码（便于单测直接调用，不 spawn 子进程）。
 */
export function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (failure) {
    error(String(failure.message ?? failure));
    error(USAGE);
    return 1;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }

  let map;
  let docText;
  try {
    const sources = loadSources(options.root);
    map = buildCapabilityMap(sources);
    assertNonVacuous(map);
    docText = sources.docText;
  } catch (failure) {
    error(`解析失败：${failure.message ?? failure}`);
    return 1;
  }

  const docPath = join(options.root, SOURCE_PATHS.doc);
  if (options.mode === 'print') {
    log(renderTable(map));
    log('');
    log(renderSummaryLine(map));
  }

  const block = parseDocBlock(docText);
  const beginCount = docText.split(DOC_BEGIN).length - 1;
  const endCount = docText.split(DOC_END).length - 1;
  if (!block.found || beginCount !== 1 || endCount !== 1) {
    error(
      `文档标记块异常：${SOURCE_PATHS.doc} 里 ${DOC_BEGIN} ×${beginCount}、${DOC_END} ×${endCount}（应各 1 处）`,
    );
    return 1;
  }

  if (options.mode === 'update') {
    const rewritten = docText.replace(
      new RegExp(`${escapeRegExp(DOC_BEGIN)}[\\s\\S]*?${escapeRegExp(DOC_END)}`),
      renderDocBlock(map),
    );
    writeFileSync(docPath, rewritten, 'utf8');
    log(`已重写标记块：${SOURCE_PATHS.doc}`);
    log(renderSummaryLine(map));
    return 0;
  }

  const mismatches = compareReadings(block.values, map);
  // 读数表之外的块内内容（前言段、逐 operation 表、族表）由整块比对兜住：
  // 只比读数时「删掉逐 op 表一行」「把说明改成已有 UI 入口」都会假绿（实测四项全 exit 0）。
  const blockDiff = compareDocBlock(docText, map);
  const consistent = mismatches.length === 0 && blockDiff === null;
  if (options.mode === 'print') {
    // 表已打印；这里只补比对结论。
    if (consistent) {
      log(`文档标记块与重算一致（${mismatches.length} 处不一致）。`);
      return 0;
    }
  }
  if (options.mode === 'check') log(renderSummaryLine(map));
  if (consistent) {
    log(`文档标记块与重算一致。`);
    return 0;
  }
  if (mismatches.length > 0) {
    error(`文档标记块与重算不一致（${mismatches.length} 处读数）：`);
    for (const mismatch of mismatches) {
      error(
        `- ${mismatch.key}：文档写 ${mismatch.documented}，重算 ${mismatch.actual}（示例 operation：${
          mismatch.exampleOperation ?? '（无）'
        }）`,
      );
    }
  }
  if (blockDiff !== null) {
    if (blockDiff.missingBlock) {
      error(`文档标记块整块比对失败：${SOURCE_PATHS.doc} 里找不到完整的 begin…end 块。`);
    } else {
      error(
        `文档标记块整块与重算不一致（第一处差异在 ${SOURCE_PATHS.doc}:${blockDiff.line}，逐字节比对，块内任何手改都算）：`,
      );
      error(`  文档：${blockDiff.documented === null ? '（块内缺这一行）' : blockDiff.documented}`);
      error(`  重算：${blockDiff.expected === null ? '（重算没有这一行）' : blockDiff.expected}`);
    }
  }
  error(`修数字请跑 \`node tools/verify-admin-capability-map.mjs --update\`；改判据请改 tools/lib/admin-capability-map.mjs。`);
  return 1;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = main();
}
