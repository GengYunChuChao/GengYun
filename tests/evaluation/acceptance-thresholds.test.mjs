// GY-I21（#21）可离线部分：**文档↔代码／需求一致性测试**。
//
// 目的：把 `docs/evaluation/acceptance-thresholds-summary.md`（首版验收门槛汇总）钉在**机器事实源**上，
// 防止数值/清单漂移回人工抄写。任一不符即失败：
//   1) 17 个样本桶、14 条指标门禁 ↔ `packages/evaluation/src/targets.mjs` 的 `SAMPLE_TARGETS` / `METRIC_GATES`（桶名/任务/数量/阈值/方向/口径）；
//   2) 样本现状计数 ↔ `docs/evaluation/sample-gap-register.md` 的真实计数（不得自估）；
//   3) 6.2 检查项与 6.3 交付物清单 ↔ `docs/implementation-requirements.md` 原文（逐字）；
//   4) 6.3 AC 清单 ↔ 同文件 `:489`，无首版接口 AC ↔ `docs/architecture/acceptance-map.md`，「设计覆盖≠运行通过」口径不冲突；
//   5) 文档自报「基线 SHA」与「现状三态」列齐备。
//
// 只读消费：本文件不修改任何门槛数值，也不修改 packages/evaluation/src/*.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_TARGETS, METRIC_GATES } from '../../packages/evaluation/src/targets.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRepo = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

const SUMMARY_REL = 'docs/evaluation/acceptance-thresholds-summary.md';
const summary = readRepo(SUMMARY_REL);
const requirements = readRepo('docs/implementation-requirements.md');
const gapRegister = readRepo('docs/evaluation/sample-gap-register.md');
const acceptanceMap = readRepo('docs/architecture/acceptance-map.md');

// —— 通用解析（Node 内置即可，不引入新依赖）——
const lines = (text) => text.split(/\r?\n/);
const cellSplit = (line) => line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
const isSeparator = (cells) => cells.every((cell) => /^:?-{2,}:?$/.test(cell));
const stripCode = (value) => value.replace(/^`|`$/g, '').trim();
const sorted = (values) => [...values].sort();

/** 解析 Markdown 中所有连续表格块（首行为表头，去掉分隔行）。 */
function parseTables(text) {
  const tables = [];
  let current = null;
  for (const line of lines(text)) {
    if (!line.startsWith('|')) {
      current = null;
      continue;
    }
    if (!current) {
      current = [];
      tables.push(current);
    }
    current.push(cellSplit(line));
  }
  return tables.map((block) => {
    const rows = block.filter((cells) => !isSeparator(cells));
    return { header: rows[0], rows: rows.slice(1) };
  });
}

const summaryTables = parseTables(summary);
function tableWithHeader(needle) {
  const hits = summaryTables.filter((table) => table.header.some((cell) => cell.includes(needle)));
  assert.equal(hits.length, 1, `汇总中应恰有 1 张表含表头「${needle}」，实际 ${hits.length}`);
  return hits[0];
}
function column(table, name) {
  const exact = table.header.indexOf(name);
  const index = exact >= 0 ? exact : table.header.findIndex((cell) => cell.includes(name));
  assert.ok(index >= 0, `表头缺少「${name}」列：${table.header.join(' | ')}`);
  return index;
}
/** 从 AC 文本解析 AC 编号集合，支持「AC06至AC09」写法。 */
function acIdsIn(text) {
  const found = new Set();
  const pattern = /AC(\d{2})(?:至AC?(\d{2}))?/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    for (let i = from; i <= to; i += 1) found.add(`AC${String(i).padStart(2, '0')}`);
  }
  return found;
}
/** 6.3 的两段原文（交付物行、AC 行）。 */
function section63Lines() {
  const section = requirements.split('### 6.3 首版交付门槛')[1].split('### 6.4')[0];
  return {
    deliverables: lines(section).find((line) => line.includes('交付比赛演示版')),
    acceptance: lines(section).find((line) => line.includes('必须在对应首版范围通过')),
  };
}
const ALL_AC = Array.from({ length: 29 }, (_, i) => `AC${String(i + 1).padStart(2, '0')}`);

// —— 1. 防漂移：基线 SHA / 生成时间 / 现状三态列 ——
test('[防漂移] 汇总自报「基线 SHA」与「生成时间」', () => {
  assert.ok(summary.includes('基线 SHA'), '汇总必须自报基线 SHA');
  assert.ok(summary.includes('生成时间'), '汇总必须自报生成时间');
  const baseLine = lines(summary).find((line) => line.includes('基线 SHA'));
  const sha = baseLine.match(/`([0-9a-f]{40})`/);
  assert.ok(sha, `基线 SHA 应为 40 位十六进制：${baseLine}`);
  assert.ok(summary.includes(`\`${sha[1].slice(0, 7)}\``), '应同时给出短 SHA，便于核对');
  assert.match(summary, /生成时间[^\n]*20\d\d-\d\d-\d\d/, '生成时间应含日期');
});

test('[防漂移] 每张清单都带「现状三态」列，取值仅限 未取得／需外部／已有组件', () => {
  const allowed = /^(未取得|需外部|已有组件)(（[^）]*）)?$/;
  const banned = ['达标', '已通过', '已达标', '成绩'];
  const withColumn = summaryTables.filter((table) => table.header.some((cell) => cell.includes('现状三态')));
  assert.equal(withColumn.length, 6, '应恰有 6 张清单带「现状三态」列（6.1 样本／6.1 门禁／6.2／6.3 交付物／6.3 AC／未取得项）');
  let checked = 0;
  for (const table of withColumn) {
    const index = column(table, '现状三态');
    for (const row of table.rows) {
      const value = row[index];
      assert.match(value, allowed, `三态取值非法：「${value}」`);
      for (const word of banned) {
        assert.ok(!value.includes(word), `三态列不得写成绩性表述（含「${word}」）：「${value}」`);
      }
      checked += 1;
    }
  }
  assert.equal(checked, 17 + 14 + 9 + 9 + 29 + 6, '「现状三态」格子总数应为 84');
  assert.ok(summary.includes('不含任何实测成绩'), '汇总应显式声明不含任何实测成绩');
});

// —— 2. 6.1 样本门槛 ↔ SAMPLE_TARGETS ↔ 缺口清单 ——
test('[6.1 样本] 17 个桶与 SAMPLE_TARGETS 逐项一致（桶名／任务／数量／口径）', () => {
  const table = tableWithHeader('bucket');
  const iBucket = column(table, 'bucket');
  const iTask = column(table, 'task');
  const iRequired = column(table, 'required');
  const iNote = column(table, '需求口径');
  assert.equal(table.rows.length, SAMPLE_TARGETS.length, `样本桶行数应等于 SAMPLE_TARGETS 长度 ${SAMPLE_TARGETS.length}`);
  assert.equal(SAMPLE_TARGETS.length, 17, 'SAMPLE_TARGETS 应为 17 个桶');
  table.rows.forEach((row, i) => {
    const source = SAMPLE_TARGETS[i];
    assert.equal(stripCode(row[iBucket]), source.bucket, `第 ${i + 1} 行桶名不符`);
    assert.equal(stripCode(row[iTask]), source.task, `${source.bucket} 任务不符`);
    assert.equal(Number(row[iRequired]), source.required, `${source.bucket} required 不符`);
    assert.ok(Number.isInteger(source.required), `${source.bucket} 源 required 应为整数`);
    assert.equal(row[iNote], source.note, `${source.bucket} 需求口径（note）不符`);
  });
});

test('[6.1 样本] 现状计数逐桶等于 sample-gap-register.md 的「实际到位」（不得自估）', () => {
  const table = tableWithHeader('bucket');
  const iBucket = column(table, 'bucket');
  const iCount = column(table, '现状计数');
  const actual = new Map();
  for (const line of lines(gapRegister)) {
    if (!line.startsWith('|')) continue;
    const cells = cellSplit(line);
    if (cells.length !== 7) continue;
    const bucket = stripCode(cells[2]);
    if (!SAMPLE_TARGETS.some((item) => item.bucket === bucket)) continue;
    const digits = cells[4].replace(/\*/g, '').match(/\d+/);
    assert.ok(digits, `缺口清单无法解析实际计数：${line}`);
    actual.set(bucket, Number(digits[0]));
  }
  assert.equal(actual.size, SAMPLE_TARGETS.length, '缺口清单应覆盖全部样本桶');
  for (const row of table.rows) {
    const bucket = stripCode(row[iBucket]);
    const pair = row[iCount].match(/^(\d+)\s*\/\s*(\d+)$/);
    assert.ok(pair, `${bucket} 现状计数格式应为「实际 / 要求」：${row[iCount]}`);
    assert.equal(Number(pair[1]), actual.get(bucket), `${bucket} 实际计数必须与缺口清单一致`);
    const source = SAMPLE_TARGETS.find((item) => item.bucket === bucket);
    assert.equal(Number(pair[2]), source.required, `${bucket} 要求值必须与 SAMPLE_TARGETS 一致`);
  }
});

// —— 3. 6.1 指标门禁 ↔ METRIC_GATES ——
test('[6.1 门禁] 14 条与 METRIC_GATES 逐项一致（指标／任务／阈值／方向／口径）', () => {
  const table = tableWithHeader('direction');
  const iMetric = column(table, 'metric');
  const iTask = column(table, 'task');
  const iTarget = column(table, 'target');
  const iDirection = column(table, 'direction');
  const iNote = column(table, '需求口径');
  assert.equal(table.rows.length, METRIC_GATES.length, `门禁行数应等于 METRIC_GATES 长度 ${METRIC_GATES.length}`);
  assert.equal(METRIC_GATES.length, 14, 'METRIC_GATES 应为 14 条');
  table.rows.forEach((row, i) => {
    const source = METRIC_GATES[i];
    assert.equal(stripCode(row[iMetric]), source.metric, `第 ${i + 1} 行指标不符`);
    assert.equal(stripCode(row[iTask]), source.task, `${source.metric} 任务不符`);
    assert.equal(Number(row[iTarget]), source.target, `${source.metric} target 不符`);
    assert.equal(stripCode(row[iDirection]), source.direction, `${source.metric} direction 不符`);
    assert.ok(['gte', 'lte', 'eq'].includes(source.direction), `${source.metric} 方向应为 gte/lte/eq`);
    assert.equal(row[iNote], source.note, `${source.metric} 需求口径（note）不符`);
  });
});

// —— 4. 6.2 检查项 ↔ 需求原文（逐字） ——
test('[6.2] 9 项检查与 implementation-requirements.md 第 6.2 节逐行一致', () => {
  const table = tableWithHeader('检查与目标');
  const iScope = column(table, '范围');
  const iCheck = column(table, '检查与目标');
  const iEvidence = column(table, '验收证据');
  const section = requirements.split('### 6.2 软件、性能与可用性验收')[1].split('### 6.3')[0];
  const sourceRows = [];
  for (const line of lines(section)) {
    if (!line.startsWith('|')) continue;
    const cells = cellSplit(line);
    if (cells.length !== 3 || cells[0] === '范围' || isSeparator(cells)) continue;
    sourceRows.push(cells);
  }
  assert.equal(sourceRows.length, 9, '第 6.2 节应有 9 项检查');
  assert.equal(table.rows.length, sourceRows.length, '汇总的 6.2 行数应与需求原文一致');
  table.rows.forEach((row, i) => {
    assert.equal(row[iScope], sourceRows[i][0], `第 ${i + 1} 行范围名不符`);
    assert.equal(row[iCheck], sourceRows[i][1], `${sourceRows[i][0]} 检查与目标应逐字复述需求原文`);
    assert.equal(row[iEvidence], sourceRows[i][2], `${sourceRows[i][0]} 验收证据应逐字复述需求原文`);
  });
});

// —— 5. 6.3 交付物清单 ↔ 需求原文 ——
test('[6.3] 交付物清单与 implementation-requirements.md 首版交付门槛一致', () => {
  const table = tableWithHeader('交付物');
  const iItem = column(table, '交付物');
  const line = section63Lines().deliverables;
  const items = line.split('：').slice(1).join('：').replace(/。\s*$/, '').split('、').map((item) => item.trim());
  assert.equal(items.length, 9, '首版交付物应为 9 项');
  assert.deepEqual(table.rows.map((row) => row[iItem]), items, '交付物清单应与需求原文一致（含顺序）');
});

// —— 6. 6.3 AC 清单 ↔ :489 ＋ 无首版接口 AC ↔ acceptance-map ——
test('[6.3 AC] 首版必过 19 项、AC15 只验静态，与 implementation-requirements.md 的 AC 清单一致', () => {
  const table = tableWithHeader('门槛归属');
  const iAc = column(table, 'AC');
  const iGate = column(table, '门槛归属');
  const clause = section63Lines().acceptance;
  const parts = clause.split('；');
  const mustPass = acIdsIn(parts[0]);
  const staticOnly = acIdsIn(parts.slice(1).join('；'));
  assert.equal(mustPass.size, 19, '首版必须通过的 AC 应为 19 项');
  assert.deepEqual(sorted(staticOnly), ['AC15'], '除 19 项外只应单列 AC15（只验静态地区科普）');
  const gateOf = (gate) => sorted(table.rows.filter((row) => row[iGate] === gate).map((row) => row[iAc]));
  for (const row of table.rows) {
    assert.ok(['首版必过', '首版静态', '无首版接口'].includes(row[iGate]), `门槛归属取值非法：${row[iGate]}`);
  }
  assert.deepEqual(gateOf('首版必过'), sorted(mustPass), '「首版必过」集合应与 :489 一致');
  assert.deepEqual(gateOf('首版静态'), sorted(staticOnly), '「首版静态」集合应与 :489 的 AC15 条款一致');
  assert.deepEqual(
    sorted([...gateOf('首版必过'), ...gateOf('首版静态'), ...gateOf('无首版接口')]),
    ALL_AC,
    '三态门槛归属应恰好划分 AC01..AC29',
  );
});

test('[6.3 AC] 「无首版接口」9 项与 acceptance-map.md 一致，场景名与需求第 8 节一致', () => {
  const table = tableWithHeader('门槛归属');
  const iAc = column(table, 'AC');
  const iScene = column(table, '场景');
  const iGate = column(table, '门槛归属');
  assert.equal(table.rows.length, 29, 'AC 表应覆盖 AC01..AC29');

  const boundaryLine = lines(acceptanceMap).find((line) => line.includes('没有首版接口'));
  assert.ok(boundaryLine, 'acceptance-map.md 应写明哪些 AC 没有首版接口');
  const boundary = boundaryLine.match(/AC([\d/]+)没有首版接口/);
  assert.ok(boundary, `无法解析无首版接口 AC 列表：${boundaryLine}`);
  const expectedNoInterface = boundary[1].split('/').map((number) => `AC${number}`);
  const actualNoInterface = table.rows.filter((row) => row[iGate] === '无首版接口').map((row) => row[iAc]);
  assert.deepEqual(sorted(actualNoInterface), sorted(expectedNoInterface), '「无首版接口」集合应与 acceptance-map.md 一致');

  const section8 = requirements.split('## 8 软件验收场景')[1].split('## 9 ')[0];
  const scenes = new Map();
  for (const line of lines(section8)) {
    if (!line.startsWith('|')) continue;
    const cells = cellSplit(line);
    if (!/^AC\d{2}$/.test(cells[0])) continue;
    scenes.set(cells[0], cells[1]);
  }
  assert.equal(scenes.size, 29, '需求第 8 节应有 29 条 AC 场景');
  for (const row of table.rows) {
    assert.equal(row[iScene], scenes.get(row[iAc]), `${row[iAc]} 场景名应与需求第 8 节一致`);
  }
});

test('[口径] 「设计覆盖 ≠ 运行通过」不冲突，程序硬口径齐备', () => {
  assert.ok(acceptanceMap.includes('设计覆盖，不是运行 AC 通过'), 'acceptance-map.md 应保留设计覆盖口径原文');
  assert.ok(summary.includes('设计覆盖'), '汇总应显式声明设计覆盖口径');
  assert.ok(summary.includes('运行通过'), '汇总应显式声明不等于运行通过');
  for (const hard of ['isRealEvaluation=false', 'gateStatus=not_evaluated', 'claimable=false']) {
    assert.ok(summary.includes(hard), `汇总应保留程序硬口径 ${hard}`);
  }
});

// —— 7. 引用真实存在：内容锚点断言（行号漂移／互换即红）——
// 本片（#158 收尾加固 + 第七项审查 F1／F2／F1b）：把「引用真实存在」变成机器门禁。
// 每条锚点三重绑定：
//   ① 该文件第 N 行**确实含**该原文片段；
//   ② 汇总里**有一行同时含该文件名与该行号标记**（引用不得与文件名脱钩）；
//   ③ 该引用行落在**预期章节**内 —— 于是「把两处行号互换」「把行号挪到别的文件那行」都会红。
// 行号漂移即红：届时在同一提交里同时改引用与断言，不允许引用悬空。
// ⚠ F1b：自动生成文件 miniprogram/data/seed-herbicides.js 只锚**内容**、不锚行号。
const AC_SECTION = '## 5 第 6.3 节 AC 清单与首版接口边界';
const summaryLines = lines(summary);
const firstHeadingIndex = summaryLines.findIndex((text) => /^##\s/.test(text));

function enclosingHeading(index) {
  for (let i = index; i >= 0; i -= 1) {
    const match = summaryLines[i].match(/^##\s+(.+?)\s*$/);
    if (match) return `## ${match[1]}`;
  }
  return '';
}

const CITATIONS = [
  { rel: 'docs/implementation-requirements.md', line: 487, fragment: '交付比赛演示版', cite: '`:487`', section: '## 4 第 6.3 节 交付物清单' },
  { rel: 'docs/implementation-requirements.md', line: 489, fragment: '必须在对应首版范围通过', cite: '`:489`', section: AC_SECTION },
  { rel: 'docs/architecture/acceptance-map.md', line: 26, fragment: '没有首版接口', cite: '`:26`', section: AC_SECTION },
  { rel: 'docs/initial-issues.md', line: 11, fragment: 'M4汇总签核', cite: '`:11`', section: '' },
  { rel: 'docs/initial-issues.md', line: 600, fragment: 'M4只是全量复评与汇总签核', cite: '`:600`', section: '' },
  { rel: 'docs/issue-revision-log.md', line: 24, fragment: 'M4 汇总签核', cite: '`:24`', section: '' },
  { rel: 'docs/ui-contract-binding.md', line: 102, fragment: '全页面搜索预警类表述', cite: '`:102`', section: AC_SECTION },
  { rel: 'docs/ui-contract-binding.md', line: 107, fragment: 'AC15 核查过程', cite: '`:107`', section: AC_SECTION },
  { rel: 'db/seeds/gy-i07/herbicides.json', line: 840, fragment: '对地下水无风险', cite: ':840', section: AC_SECTION },
  { rel: 'packages/knowledge/zhejiang/materials-zhejiang-v1.json', line: 10505, fragment: '对地下水无风险', cite: ':10505', section: AC_SECTION },
];

test('[引用] 逐条锚点断言：该行确实含该原文片段，且汇总在同一行、同一章节内引用它', () => {
  assert.equal(CITATIONS.length, 10, '锚点清单应逐条列全 10 处引用（删项即红）');
  assert.ok(!CITATIONS.some((item) => item.rel.endsWith('seed-herbicides.js')), '自动生成文件不得锚行号（F1b：只锚内容）');
  for (const { rel, line, fragment, cite, section } of CITATIONS) {
    const target = lines(readRepo(rel))[line - 1];
    assert.ok(target !== undefined, `${rel} 不足 ${line} 行（引用已漂移）`);
    assert.ok(target.includes(fragment), `${rel}:${line} 应含「${fragment}」，实际：${target.slice(0, 90)}`);
    const shown = rel.split('/').pop();
    // 只在「同一区域」内找引用行：文首说明（首个 `## ` 之前）的「行号口径」清单会一次性列出所有
    // 行号标记，若不排除它会假命中；正文引用则只认正文，反之亦然。
    const index = summaryLines.findIndex((text, i) => {
      if ((i < firstHeadingIndex) !== (section === '')) return false;
      return text.includes(shown) && text.includes(cite);
    });
    assert.ok(index >= 0, `汇总应有一行同时含「${shown}」与「${cite}」：引用不得与文件名脱钩`);
    assert.equal(
      enclosingHeading(index),
      section,
      `${shown} 的「${cite}」应出现在「${section || '文首说明'}」章节内（行号互换／挪行即红）`,
    );
  }
});

test('[引用] 自动生成文件只锚内容不锚行号（F1b）', () => {
  assert.ok(
    readRepo('miniprogram/data/seed-herbicides.js').includes('对地下水无风险'),
    '自动生成的种子数据文件应含该句（内容锚点；行号不锚，避免生成物行号漂移造成误判）',
  );
});

test('[引用] AC15 的结论性表述带证据指针（删掉指针即红）', () => {
  const table = tableWithHeader('门槛归属');
  const iAc = column(table, 'AC');
  const iStatus = column(table, '现状三态');
  const row = table.rows.find((cells) => cells[iAc] === 'AC15');
  assert.ok(row, 'AC 表应含 AC15 行');
  assert.ok(row[iStatus].includes('ui-contract-binding.md'), `AC15 的现状三态格应给出证据指针，实际：${row[iStatus]}`);
});
