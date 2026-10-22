#!/usr/bin/env node
// 把 targets.mjs 的逐条依据渲染成 docs/evaluation/threshold-basis.md 的表格块（单一真相 = 代码）。
// 用法：
//   node tools/evaluation/render-threshold-tables.mjs            # 仅打印（供测试比对）
//   node tools/evaluation/render-threshold-tables.mjs --write    # 原地重写文档中的生成块
// 为什么存在：门槛数字与"为什么是这个数"分散在代码与文档两处时，迟早一处被改、另一处没人管；
//   本脚本让文档表格由代码生成，`tests/evaluation/threshold-basis.test.mjs` 逐字节比对，
//   于是"改阈值不改说明"会直接测试红。
import { readFileSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { METRIC_GATES, SAMPLE_TARGETS, PROVISIONAL_MARKER, THRESHOLD_BASIS_DOC } from '../../packages/evaluation/index.mjs';

export const BEGIN_MARKER = '<!-- BEGIN GENERATED: threshold-basis tables（由 tools/evaluation/render-threshold-tables.mjs 生成，勿手改） -->';
export const END_MARKER = '<!-- END GENERATED: threshold-basis tables -->';

const DIRECTION_TEXT = { gte: '≥ target', lte: '≤ target', eq: '= target' };
const KIND_TEXT = { requirement: '需求原文', provisional: '暂定' };

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** 渲染两张表（样本数量目标 + 指标门禁），纯函数便于测试。
 *  条数一律从数组长度取数：标题里写死「17 桶 / 14 条」会在新增门槛后撒谎
 *  （生成文档与代码脱节），本函数因此不接受任何数量入参。 */
export function renderThresholdTables() {
  const lines = [];
  lines.push(`### 1. 样本数量目标（${SAMPLE_TARGETS.length} 桶）`);
  lines.push('');
  lines.push('| bucket | task | required | 依据类别 | 依据位置 | 为什么是这个数 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const t of SAMPLE_TARGETS) {
    lines.push(`| \`${t.bucket}\` | \`${t.task}\` | ${t.required} | ${KIND_TEXT[t.basis.kind]} | \`${t.basis.ref}\` | ${cell(t.basis.text)} |`);
  }
  lines.push('');
  lines.push(`### 2. 指标门槛（${METRIC_GATES.length} 条）`);
  lines.push('');
  lines.push('| metric | task | target | 方向 | 依据类别 | 依据位置 | 为什么是这个数 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const g of METRIC_GATES) {
    lines.push(`| \`${g.metric}\` | \`${g.task}\` | ${g.target} | ${DIRECTION_TEXT[g.direction]} | ${KIND_TEXT[g.basis.kind]} | \`${g.basis.ref}\` | ${cell(g.basis.text)} |`);
  }
  const provisional = [...SAMPLE_TARGETS, ...METRIC_GATES].filter((x) => x.basis.kind === 'provisional');
  lines.push('');
  lines.push(`### 3. 暂定条目（${provisional.length} 条）`);
  lines.push('');
  if (provisional.length === 0) {
    lines.push('无。');
  } else {
    lines.push(`以下条目的取值被需求原文交给验证集/实测确定，本片**未取得**该读数，因此一律标 \`provisional\`，口径句为「${PROVISIONAL_MARKER}」。未按 \`pass\` 主张。`);
    lines.push('');
    for (const p of provisional) {
      const key = p.bucket ? `\`${p.bucket}\`（样本量 ${p.required}）` : `\`${p.metric}\`（target ${p.target}）`;
      lines.push(`- ${key}：${cell(p.basis.text)}`);
    }
  }
  return lines.join('\n');
}

/** 用渲染结果替换文档中 BEGIN/END 之间的内容；返回新全文。 */
export function spliceIntoDoc(docText) {
  const begin = docText.indexOf(BEGIN_MARKER);
  const end = docText.indexOf(END_MARKER);
  if (begin < 0 || end < 0 || end < begin) throw new Error(`文档缺少生成块标记：${BEGIN_MARKER} / ${END_MARKER}`);
  return `${docText.slice(0, begin + BEGIN_MARKER.length)}\n${renderThresholdTables()}\n${docText.slice(end)}`;
}

function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const docPath = join(repoRoot, THRESHOLD_BASIS_DOC);
  const text = readFileSync(docPath, 'utf8');
  if (process.argv.includes('--write')) {
    writeFileSync(docPath, spliceIntoDoc(text));
    process.stdout.write(`已重写 ${THRESHOLD_BASIS_DOC} 的生成块\n`);
    return;
  }
  process.stdout.write(`${renderThresholdTables()}\n`);
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
