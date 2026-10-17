#!/usr/bin/env node
// GY-I21 评估链 CI 读数断言（零依赖）。
//
// 用法：node tools/evaluation/verify-gate-readout.mjs <run-evaluation.log> <freeze-real-samples.log> <validate-evaluation-samples.log>
//
// 每份输出必须命中该文件对应的**全部**字面量；缺一条即 exit 1，并打印缺哪一条。
// 字面量全部抄自本机真跑输出（见 `.pg17/handoff/impl-i21-evaluation-chain.md`），
// 不是按字段名猜的：改这些字面量＝改对外承诺，必须先改读数来源再改这里。
import { readFileSync } from 'node:fs';

const SPECS = [
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

function main() {
  const paths = process.argv.slice(2);
  if (paths.length !== SPECS.length) {
    process.stderr.write(
      '用法：node tools/evaluation/verify-gate-readout.mjs <run-evaluation.log> <freeze-real-samples.log> <validate-evaluation-samples.log>\n',
    );
    process.exit(2);
  }

  let failures = 0;
  SPECS.forEach((spec, index) => {
    const path = paths[index];
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      failures += 1;
      process.stdout.write(`FAIL ${spec.label}: 读不到输出文件 ${path}（${error.message}）\n`);
      return;
    }
    for (const item of spec.literals) {
      if (item.text === '') {
        failures += 1;
        process.stdout.write(`FAIL ${spec.label}: 断言字面量为空串（无效断言）——${item.why}\n`);
        continue;
      }
      if (text.includes(item.text)) {
        process.stdout.write(`PASS ${spec.label}: 命中 ${JSON.stringify(item.text)}\n`);
      } else {
        failures += 1;
        process.stdout.write(`FAIL ${spec.label}: 缺 ${JSON.stringify(item.text)}（${item.why}）\n`);
      }
    }
  });

  if (failures > 0) {
    process.stdout.write(`FAIL 读数断言：${failures} 条不满足，job 必须红\n`);
    process.exit(1);
  }
  process.stdout.write('PASS 读数断言：三份输出全部命中约定读数（绿只表示读数与约定一致，不表示真实评估成立）\n');
}

main();
