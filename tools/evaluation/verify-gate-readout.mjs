#!/usr/bin/env node
// GY-I21 评估链 CI 读数断言（零依赖）。
//
// 用法：node tools/evaluation/verify-gate-readout.mjs <run-evaluation.log> <freeze-real-samples.log> <validate-evaluation-samples.log> [run-evaluation-report.json]
//
// 三参：每份输出必须命中该文件对应的**全部**字面量；缺一条即 exit 1，并打印缺哪一条。
// 四参：先做同样的三参断言，再对 `run-evaluation.mjs --out` 落盘的报告 JSON 做结构化断言。
//   结构化断言不是「换一批字面量」，而是按字段核形状与取值：
//   `schemaVersion` 须与 schema 一致、`isRealEvaluation` 须为 false、每个 task 的
//   `gateStatus` 须为 not_evaluated、`gaps` 须与日志里的「样本缺口桶：X/Y 未达标」逐字一致。
//   `tasks`／`gaps` 为空一律判红：空集等于没有证据，不得当作通过。
// 字面量全部抄自本机真跑输出（见 `.pg17/handoff/impl-i21-evaluation-chain.md`），
// 不是按字段名猜的：改这些字面量＝改对外承诺，必须先改读数来源再改这里。
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SPECS = [
  {
    label: 'run-evaluation',
    literals: [
      { text: 'not_evaluated', why: '空预测下门禁必须保持未评估，不得被悄悄记成通过' },
      { text: '"isRealEvaluation": false', why: '报告须自陈 isRealEvaluation=false（真实评估未成立）' },
      { text: '样本缺口桶：16/17 未达标', why: '覆盖缺口桶读数须与冻结样本现状一致' },
    ],
  },
  {
    label: 'freeze-real-samples --verify',
    literals: [
      { text: '复算核对', why: '脚本确实走到了复算核对分支' },
      { text: '冻结=通过', why: '冻结清单与索引复算一致' },
      { text: '覆盖绑定：通过', why: '覆盖绑定一致' },
    ],
  },
  {
    label: 'validate-evaluation-samples',
    literals: [
      { text: '样本索引：', why: '脚本确实加载了索引文件（而非空跑）' },
      { text: '校验结果：通过（无错误）', why: '样本索引合规校验通过' },
    ],
  },
];

/** 报告 schema 的版本号：与 `packages/evaluation/schema/run-report.schema.json` 里 `schemaVersion` 的 `const` 同源。 */
const REPORT_SCHEMA_VERSION = '1.0.0';

/** 日志里的缺口桶读数行；`formatSummary` 就是这么写的，结构化断言据此对账。 */
const GAP_LINE = /样本缺口桶：(\d+)\/(\d+) 未达标/gu;

const USAGE =
  '用法：node tools/evaluation/verify-gate-readout.mjs <run-evaluation.log> <freeze-real-samples.log> <validate-evaluation-samples.log>\n' +
  '     可选第 4 个参数：`run-evaluation.mjs --out` 落盘的报告 JSON（给出时追加结构化断言）\n';

const defaultReadFile = (path) => readFileSync(path, 'utf8');

/** 报告顶层若连对象都不是，后续字段断言无从谈起，直接给一句人话。 */
function describeTopLevel(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return typeof value;
}

/**
 * 结构化断言：读报告 JSON，逐项核 `schemaVersion`／`isRealEvaluation`／`tasks[*].gateStatus`，
 * 并把 `gaps` 与日志里的「样本缺口桶：X/Y 未达标」对账。
 * 返回 `{ failures, lines }`；断言失败只累加计数，不抛异常（由调用方决定退出码）。
 */
export function inspectReport({ reportPath, logText = null, readFile = defaultReadFile }) {
  const lines = [];
  let failures = 0;
  const fail = (message) => {
    failures += 1;
    lines.push(`FAIL 结构化断言：${message}`);
  };
  const pass = (message) => lines.push(`PASS 结构化断言：${message}`);

  let raw;
  try {
    raw = readFile(reportPath);
  } catch (error) {
    fail(`读不到报告 JSON ${reportPath}（${error.message}）`);
    return { failures, lines };
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    fail(`报告不是合法 JSON（${error.message}）`);
    return { failures, lines };
  }
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    fail(`报告顶层必须是对象（实测${describeTopLevel(report)}）`);
    return { failures, lines };
  }

  if (report.schemaVersion === REPORT_SCHEMA_VERSION) {
    pass(`schemaVersion=${REPORT_SCHEMA_VERSION}`);
  } else {
    fail(`schemaVersion 必须是 "${REPORT_SCHEMA_VERSION}"（实测 ${JSON.stringify(report.schemaVersion)}）`);
  }

  if (report.isRealEvaluation === false) {
    pass('isRealEvaluation=false');
  } else {
    fail(`isRealEvaluation 必须是 false（实测 ${JSON.stringify(report.isRealEvaluation)}）`);
  }

  const tasks = report.tasks;
  if (tasks === null || typeof tasks !== 'object' || Array.isArray(tasks) || Object.keys(tasks).length === 0) {
    fail(`tasks 不是非空对象（实测${describeTopLevel(tasks)}，空集不得当作「全部门禁未评估」）`);
  } else {
    for (const [name, task] of Object.entries(tasks)) {
      if (task === null || typeof task !== 'object' || Array.isArray(task)) {
        fail(`tasks.${name} 必须是对象（实测${describeTopLevel(task)}）`);
        continue;
      }
      if (task.gateStatus === 'not_evaluated') {
        pass(`tasks.${name}.gateStatus=not_evaluated`);
      } else {
        fail(`tasks.${name}.gateStatus 必须是 "not_evaluated"（实测 ${JSON.stringify(task.gateStatus)}）`);
      }
    }
  }

  const gaps = report.gaps;
  if (!Array.isArray(gaps) || gaps.length === 0) {
    fail(`gaps 不是非空数组（实测${describeTopLevel(gaps)}${Array.isArray(gaps) ? '(长度 0)' : ''}，空集不得当作「无缺口」）`);
    return { failures, lines };
  }
  const malformed = gaps.filter((gap) => gap === null || typeof gap !== 'object' || !Number.isFinite(gap.missing));
  if (malformed.length > 0) {
    fail(`gaps 有 ${malformed.length} 项缺少数值型 missing，无法核对缺口桶计数`);
    return { failures, lines };
  }
  const under = gaps.filter((gap) => gap.missing > 0).length;
  const denominator = gaps.length;

  if (typeof logText !== 'string') {
    fail('run-evaluation.log 不可读，无法核对缺口桶读数');
    return { failures, lines };
  }
  const matches = [...logText.matchAll(GAP_LINE)];
  const distinct = new Set(matches.map((match) => match[0]));
  if (matches.length === 0) {
    fail('run-evaluation.log 缺「样本缺口桶：X/Y 未达标」这一行，无法核对缺口读数');
    return { failures, lines };
  }
  if (distinct.size > 1) {
    fail(`run-evaluation.log 的「样本缺口桶」出现 ${matches.length} 次且读数不一致：${[...distinct].join(' / ')}`);
    return { failures, lines };
  }
  const [numerator, total] = [Number(matches[0][1]), Number(matches[0][2])];
  if (numerator === under && total === denominator) {
    pass(`缺口桶 ${numerator}/${total} 与报告一致（未达标 ${under} 桶 / 共 ${denominator} 桶）`);
  } else {
    fail(`日志缺口桶 ${numerator}/${total} 与报告不一致（报告：未达标 ${under} 桶 / 共 ${denominator} 桶）`);
  }
  return { failures, lines };
}

/**
 * 断言主体：三参＝按字面量核三份日志；四参＝再追加报告结构化断言。
 * 纯函数（只经 `readFile` 读入参给的路径），返回 `{ exitCode, lines }`，由 `main()` 决定怎么打印与退出。
 */
export function verifyReadout(paths, { readFile = defaultReadFile } = {}) {
  const lines = [];
  const texts = [];
  let failures = 0;

  SPECS.forEach((spec, index) => {
    const path = paths[index];
    let text;
    try {
      text = readFile(path);
    } catch (error) {
      failures += 1;
      texts.push(null);
      lines.push(`FAIL ${spec.label}: 读不到输出文件 ${path}（${error.message}）`);
      return;
    }
    texts.push(text);
    for (const item of spec.literals) {
      if (item.text === '') {
        failures += 1;
        lines.push(`FAIL ${spec.label}: 断言字面量为空串（无效断言）——${item.why}`);
        continue;
      }
      if (text.includes(item.text)) {
        lines.push(`PASS ${spec.label}: 命中 ${JSON.stringify(item.text)}`);
      } else {
        failures += 1;
        lines.push(`FAIL ${spec.label}: 缺 ${JSON.stringify(item.text)}（${item.why}）`);
      }
    }
  });

  if (paths.length === SPECS.length + 1) {
    const structured = inspectReport({ reportPath: paths[SPECS.length], logText: texts[0], readFile });
    failures += structured.failures;
    lines.push(...structured.lines);
  }

  if (failures > 0) {
    lines.push(`FAIL 读数断言：${failures} 条不满足，job 必须红`);
    return { exitCode: 1, lines };
  }
  const tail = '（绿只表示读数与约定一致，不表示真实评估成立）';
  lines.push(
    paths.length === SPECS.length + 1
      ? `PASS 读数断言：三份输出全部命中约定读数，报告结构化断言通过${tail}`
      : `PASS 读数断言：三份输出全部命中约定读数${tail}`,
  );
  return { exitCode: 0, lines };
}

/** 只有作为脚本直接执行才解析 argv：被测试 import 时不得读测试进程的参数、更不得退出。 */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

function main() {
  const paths = process.argv.slice(2);
  if (paths.length !== SPECS.length && paths.length !== SPECS.length + 1) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const { exitCode, lines } = verifyReadout(paths);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exitCode = exitCode;
}

if (isMainModule()) main();
