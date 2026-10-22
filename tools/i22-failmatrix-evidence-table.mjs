/**
 * GY-I22（#22）失败矩阵 · 证据表生成器。
 *
 * 为什么要有这个工具：矩阵的期望值全部来自**真读数**，文档里的三列表
 * （用例 id → #22 acceptance 条目 → 实际读数）如果靠手抄，早晚会与代码漂移。
 * 这里改成「跑真矩阵 → 取机读结果 → 生成 Markdown → 写进证据页标记之间」：
 * 文档里的每一行读数都出自一次真实运行，重跑一次即可复核。
 *
 * 用法：
 *   node tests/failmatrix/run.mjs --json=tests/failmatrix/.artifacts/matrix.json
 *   node tools/i22-failmatrix-negative-control.mjs --json=tests/failmatrix/.artifacts/negative-control.json
 *   node tools/i22-failmatrix-evidence-table.mjs            # 打印到 stdout
 *   node tools/i22-failmatrix-evidence-table.mjs --write    # 写进证据页标记之间
 *
 * 标记（证据页里各一对，工具只替换标记之间的内容）：
 *   <!-- BEGIN:MATRIX-TABLE --> … <!-- END:MATRIX-TABLE -->
 *   <!-- BEGIN:NEGATIVE-CONTROL-TABLE --> … <!-- END:NEGATIVE-CONTROL-TABLE -->
 *
 * 退出码：0 = 生成成功且与运行结果自洽；1 = 条数/判定与文档声明不符（不许悄悄少用例）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'docs/verification/gy-i22-failmatrix-20261022.md';

/** 每条用例的族 → #22 的 acceptance 条目（自评映射；最终由监工裁决）。 */
const FAMILY_ACCEPTANCE = Object.freeze({
  C1: 'AC01',
  C2: 'AC01/AC02',
  C3: 'AC02/AC07',
  C4: 'AC08/AC09',
  C5: 'AC09/AC13',
  C6: 'AC16',
  C7: 'AC19',
  E1: 'AC21（F08 提示注入只作数据）',
  E2: 'AC13/AC22（F20 媒体访问凭据）',
  D1: 'AC23（F13 任务状态机：旧回调不复活）',
  D2: 'AC21/AC23（F13/F20 AI 失败不得发布）',
  D3: 'AC22（G4 下架 ⇒ 缓存失效）',
  D4: 'AC22/AC29（内容版本变更 ⇒ 旧结论不复用）',
});

/** 文档声明的条数；生成结果与之不符即失败（防止有人删用例让矩阵「变绿」）。 */
const EXPECTED = Object.freeze({
  families: { C1: 37, C2: 24, C3: 27, C4: 18, C5: 10, C6: 10, C7: 16, E1: 3, E2: 3, D1: 11, D2: 4, D3: 2, D4: 3 },
  batches: { B1: 106, B2: 36, B3: 17, B4: 9 },
  total: 168,
  negativeControls: 23,
});

function parseArgs(argv) {
  const out = { matrix: 'tests/failmatrix/.artifacts/matrix.json', nc: 'tests/failmatrix/.artifacts/negative-control.json', page: PAGE, write: false };
  for (const arg of argv) {
    if (arg === '--write') out.write = true;
    else if (arg.startsWith('--matrix=')) out.matrix = arg.slice('--matrix='.length);
    else if (arg.startsWith('--nc=')) out.nc = arg.slice('--nc='.length);
    else if (arg.startsWith('--page=')) out.page = arg.slice('--page='.length);
    else throw new Error(`未知参数：${arg}`);
  }
  return out;
}

function readJson(relative) {
  const file = path.join(ROOT, relative);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`读不到运行结果 ${relative}：${error.message}\n先把矩阵与负控制各跑一遍并写 --json。`);
  }
}

function shortSha(sha) {
  return typeof sha === 'string' && sha.length >= 16 ? `${sha.slice(0, 16)}…` : String(sha);
}

function renderMatrix(matrix) {
  const lines = [];
  lines.push(`一次真跑：${matrix.generated_at} · node ${matrix.node} · 基线 ${String(matrix.base_commit).slice(0, 10)} · 传输方式 \`${matrix.transport}\`。`);
  lines.push('');
  lines.push('| 用例 id | 族 | 期望 | 实际读数（status · code · cache · etag） | #22 acceptance（自评） | 判定 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const row of matrix.rows) {
    const expected = row.expected.status + (row.expected.code ? ` ${row.expected.code}` : '');
    const actual = [
      row.actual.status,
      row.actual.code ?? '—',
      row.actual.cache ?? '—',
      row.actual.etag ?? '—',
    ].join(' · ');
    lines.push(`| \`${row.id}\` | ${row.family} | ${cell(expected)} | ${cell(actual)} | ${cell(FAMILY_ACCEPTANCE[row.family] ?? '—')} | ${row.verdict} |`);
  }
  return lines.join('\n');
}

function renderNegativeControls(nc) {
  const lines = [];
  lines.push(`一次真跑：${nc.generated_at} · node ${nc.node} · **合计 ${nc.total} 条：PASS ${nc.pass} / FAIL ${nc.fail}**。`);
  lines.push('');
  lines.push('| 负控制 | 真改的那一处 | watch（必须真红） | sha256 改前（前 16 位） | 恢复后一致 | 判定 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const entry of nc.entries) {
    const files = entry.files ?? [entry.file];
    const before = entry.evidence?.sha256_before ?? {};
    const restored = Object.entries(before).map(([file, sha]) => `${path.basename(file)}=${shortSha(sha)}`).join('；');
    const same = String(entry.verdict === 'PASS');
    lines.push(
      `| \`${entry.id}\` ${cell(entry.title)} | ${cell(files.map((file) => `\`${file}\``).join(' + '))} | ${cell(entry.watch.join(', '))} | ${cell(restored)} | ${same} | ${entry.verdict} |`,
    );
  }
  return lines.join('\n');
}

function cell(text) {
  return String(text).replaceAll('|', '\\|');
}

function replaceBetween(page, marker, body) {
  const begin = `<!-- BEGIN:${marker} -->`;
  const end = `<!-- END:${marker} -->`;
  const start = page.indexOf(begin);
  const stop = page.indexOf(end);
  if (start < 0 || stop < 0 || stop < start) throw new Error(`证据页缺少标记 ${begin} … ${end}`);
  return `${page.slice(0, start + begin.length)}\n${body}\n${page.slice(stop)}`;
}

function check(expected, actual, where, problems) {
  if (expected !== actual) problems.push(`${where} 期望 ${expected} 条，实际 ${actual} 条`);
}

function main(argv) {
  const opts = parseArgs(argv);
  const matrix = readJson(opts.matrix);
  const nc = readJson(opts.nc);
  const problems = [];

  check(EXPECTED.total, matrix.totals.total, '总条数', problems);
  for (const [family, count] of Object.entries(EXPECTED.families)) check(count, matrix.families[family]?.total, `族 ${family}`, problems);
  for (const [batch, count] of Object.entries(EXPECTED.batches)) {
    const row = (matrix.batches ?? []).find((one) => one.id === batch);
    check(count, row?.total, `批次 ${batch}`, problems);
  }
  const failed = matrix.rows.filter((row) => row.verdict !== 'PASS');
  if (failed.length > 0) problems.push(`矩阵有 ${failed.length} 条非 PASS：${failed.map((row) => row.id).join(', ')}`);
  check(EXPECTED.negativeControls, nc.total, '负控制条数', problems);
  if (nc.fail !== 0) problems.push(`负控制有 ${nc.fail} 条 FAIL`);

  const matrixTable = renderMatrix(matrix);
  const ncTable = renderNegativeControls(nc);

  if (opts.write) {
    const pagePath = path.join(ROOT, opts.page);
    let page = readFileSync(pagePath, 'utf8');
    page = replaceBetween(page, 'MATRIX-TABLE', matrixTable);
    page = replaceBetween(page, 'NEGATIVE-CONTROL-TABLE', ncTable);
    writeFileSync(pagePath, page, 'utf8');
    console.log(`写入 ${opts.page}：矩阵 ${matrix.rows.length} 行、负控制 ${nc.entries.length} 行`);
  } else {
    console.log(matrixTable);
    console.log('');
    console.log(ncTable);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    return 1;
  }
  console.log(`自洽：矩阵 ${matrix.totals.total} 条全 PASS、负控制 ${nc.total} 条全 PASS，与文档声明一致。`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
