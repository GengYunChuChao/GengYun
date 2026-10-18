/**
 * `tools/verify-research-records.mjs` 的判据测试。
 *
 * 为什么需要它：`npm run test:docs` 里那条命令一旦被判据写松（按项来源退化成记录级总数、
 * 把围栏／注释里的字段也算数、把 `1048576` 当版本号、白名单给新记录开后门），
 * **它自己不会红**——只会静默变绿。本文件用**临时目录夹具**逐条证明每个判据真的会触发，
 * 并证明合规记录（含 README §7 范例本身）不会被误判。
 *
 * 边界：⛔ 不触碰仓库内真实 `docs/`（只读 `tools/` 与被测脚本）；⛔ 不联网；
 * 夹具全部写在 `os.tmpdir()` 下并在用例结束时删除。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（tests/unit/ → ../..），⛔ 不用 process.cwd()。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GATE = join(REPO_ROOT, 'tools', 'verify-research-records.mjs');
const README = join(REPO_ROOT, 'docs', 'research', 'README.md');

/** 夹具固定日期（真实日历日），⛔ 不取 `new Date()`，否则用例随日期漂移。 */
const DAY = '2026-10-18';
const URL_A = 'https://nodejs.org/api/test.html';
const URL_B = 'https://nodejs.org/en/about/previous-releases';
const URL_C = 'https://registry.npmjs.org/typescript';
const URL_D = 'https://www.npmjs.com/package/typescript';
const LEGACY_NAME = 'gy-i03-fixture-20261011.md';
const LEGACY_BODY = '# 夹具 legacy 记录\n\n夹具正文。\n';

const lfSha256 = (text) =>
  createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

const FIELDS = [
  ['现用版本（证据命令）', '`node --version` ⇒ v24.16.0'],
  ['上游维护状态', 'LTS 至 2026-10（来源 1、来源 2）'],
  ['可复用部分', '`node:test`／`node:assert`（2 个内置模块）'],
  ['许可证与署名', 'MIT'],
  ['兼容性', 'Node 24 ＋ ESM'],
  ['引入成本', '0 个新依赖'],
  ['决定', '自研；理由：夹具']
];

function allowlistJson(entries) {
  const files = {};
  for (const [name, sha256] of Object.entries(entries)) {
    files[name] = { sha256, reason: '夹具：历史记录不得改写，只能钉住。' };
  }
  return `${JSON.stringify({ schema: 1, hashMethod: 'sha256-utf8-lf-normalized', files }, null, 2)}\n`;
}

/** 建临时工作目录；`files` 为 name → 文件内容（字符串按 UTF-8 写入）。 */
function makeWorkspace(t, files, { withReadme = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gy-research-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (withReadme) writeFileSync(join(dir, 'README.md'), '# 夹具 README\n\n夹具制度文件。\n');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

/** 跑被测脚本，返回退出码与两路输出。 */
function runGate(dir, args = [dir]) {
  const result = spawnSync(process.execPath, [GATE, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    windowsHide: true,
    timeout: 30000
  });
  assert.equal(result.error, undefined, `子进程未启动：${result.error?.message ?? ''}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** 记录级四项（README §4）。 */
function recordHead({ date = DAY, omit = [], version = 'v24.16.0' } = {}) {
  const lines = [];
  if (!omit.includes('检索日期')) lines.push(`- 检索日期：${date}`);
  if (!omit.includes('检索方式')) lines.push('- 检索方式：直接抓取官方页，未使用检索词');
  if (!omit.includes('来源版本或提交')) lines.push(`- 来源版本或提交：${version}`);
  return lines;
}

/** README §7 的"最短记录"夹具；`omit` 用于注入缺项，`sources` 用于注入来源条数。 */
function minimalRecord({ omit = [], sources = [URL_A, URL_B], tail = [] } = {}) {
  return [
    `# ${DAY} 夹具最短记录`,
    '',
    ...recordHead({ omit }),
    `- 来源：${sources.join('；')}`,
    '- 决定：不引入。理由：夹具。',
    '',
    ...tail
  ].join('\n');
}

/** 一段技术（`## N <名称>` + 七字段 + 检索来源子表）；`fieldStyle` 决定字段形状。 */
function techSection(index, name, urls, { fieldStyle = 'list', drop = null, extraField = null } = {}) {
  const fields = FIELDS.filter(([field]) => field !== drop);
  const lines = [`## ${index} ${name}`, ''];
  if (fieldStyle === 'list') {
    for (const [field, value] of fields) lines.push(`- ${field}：${value}`);
  } else if (fieldStyle === 'table') {
    lines.push('| 项 | 内容 |', '| --- | --- |');
    for (const [field, value] of fields) lines.push(`| ${field} | ${value} |`);
  } else if (fieldStyle === 'shifted') {
    lines.push('| # | 项 | 内容 |', '| --- | --- | --- |');
    fields.forEach(([field, value], order) => lines.push(`| ${order + 1} | ${field} | ${value} |`));
  }
  if (extraField !== null) {
    // 表格式多出来的行必须落在字段列上（table ⇒ 第 1 列，shifted ⇒ 第 2 列）。
    if (fieldStyle === 'list') lines.push(`- ${extraField}：夹具`);
    else if (fieldStyle === 'table') lines.push(`| ${extraField} | 夹具 |`);
    else lines.push(`| ${fields.length + 1} | ${extraField} | 夹具 |`);
  }
  lines.push('', '### 检索来源', '');
  if (urls.length > 0) {
    lines.push('| # | URL | 本轮读数 |', '| --- | --- | --- |');
    urls.forEach((url, order) => lines.push(`| ${order + 1} | <${url}> | 夹具读数 |`));
  } else {
    lines.push('（本条未取得来源——夹具故意留空。）');
  }
  lines.push('');
  return lines;
}

/** 完整记录夹具：`items` 为 [{name, urls, fieldStyle, drop}]。 */
function completeRecord(items, { omit = [] } = {}) {
  const lines = [`# ${DAY} 夹具完整记录`, '', ...recordHead({ omit }), ''];
  items.forEach((item, order) => {
    lines.push(...techSection(order + 1, item.name, item.urls, item));
  });
  return lines.join('\n');
}

/** 从 README 里取某个小节的第一段围栏代码（§7 范例／§6 模板都要能照抄）。 */
function readmeCodeBlock(sectionNumber) {
  const text = readFileSync(README, 'utf8');
  const start = text.indexOf(`\n## ${sectionNumber} `);
  assert.ok(start >= 0, `docs/research/README.md 缺少 §${sectionNumber}`);
  const fence = /```(?:markdown|md)?\r?\n([\s\S]*?)```/u.exec(text.slice(start));
  assert.ok(fence !== null, `docs/research/README.md §${sectionNumber} 里没有代码块`);
  return fence[1];
}

test('合格的最短记录 ⇒ exit 0，并逐条打印 PASS 与统计', (t) => {
  const dir = makeWorkspace(t, { [`${DAY}-fixture-minimal.md`]: minimalRecord() });
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS 2026-10-18-fixture-minimal\.md/u);
  assert.match(result.stdout, /研究记录校验：1 通过 \/ 0 失败 \/ 0 legacy 已钉住/u);
});

test('照抄 README §7 范例 ⇒ exit 0（范例必须真能过门禁）', (t) => {
  const example = readmeCodeBlock(7);
  const date = /检索日期：(\d{4}-\d{2}-\d{2})/u.exec(example);
  assert.ok(date !== null, 'README §7 范例缺「检索日期」');
  const dir = makeWorkspace(t, { [`${date[1]}-fixture-readme-example.md`]: example });
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('完整记录·七项写成列表形态 ⇒ exit 0', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-list-fields.md`]: completeRecord([{ name: 'Node.js', urls: [URL_A, URL_B] }])
  });
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('完整记录·七项写成表格且字段在第 2 列（`| # | 项 | 内容 |`）⇒ exit 0', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-table-fields.md`]: completeRecord([
      { name: 'Node.js', urls: [URL_A, URL_B], fieldStyle: 'shifted' }
    ])
  });
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('完整记录·字段表在第 2 列且缺「引入成本」⇒ exit 1 且点名该字段', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-shifted-missing.md`]: completeRecord([
      { name: 'Node.js', urls: [URL_A, URL_B], fieldStyle: 'shifted', drop: '引入成本' }
    ])
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /缺少字段：引入成本/u);
});

test('完整记录·列表形态的七项全删 ⇒ exit 1（不得静默降级成最短记录）', (t) => {
  const body = completeRecord([{ name: 'Node.js', urls: [URL_A, URL_B] }]);
  const stripped = body
    .split('\n')
    .filter((line) => !FIELDS.some(([field]) => line.startsWith(`- ${field}：`)))
    .join('\n');
  assert.ok(!stripped.includes('- 引入成本：'), '夹具应删掉全部字段行');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-no-fields.md`]: stripped });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /缺少字段：现用版本/u);
});

test('按项来源：四项技术各 1 条 URL（记录级总数 4）⇒ exit 1', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-one-each.md`]: completeRecord([
      { name: 'Node.js', urls: [URL_A] },
      { name: 'TypeScript', urls: [URL_C] },
      { name: 'Fastify', urls: ['https://github.com/fastify/fastify'] },
      { name: 'PostgreSQL', urls: ['https://www.postgresql.org/support/versioning/'] }
    ])
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /来源 URL 少于 2 条（去重后 1 条）/u);
});

test('按项来源：一项独占 4 条、另三项 0 条 ⇒ exit 1', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-hoard.md`]: completeRecord([
      { name: 'Node.js', urls: [URL_A, URL_B, URL_C, URL_D] },
      { name: 'TypeScript', urls: [] },
      { name: 'Fastify', urls: [] },
      { name: 'PostgreSQL', urls: [] }
    ])
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /来源 URL 少于 2 条（去重后 0 条）/u);
});

test('按项来源：两项各 2 条、另两项 0 条 ⇒ exit 1（只报空的两项）', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-half.md`]: completeRecord([
      { name: 'Node.js', urls: [URL_A, URL_B] },
      { name: 'TypeScript', urls: [URL_C, URL_D] },
      { name: 'Fastify', urls: [] },
      { name: 'PostgreSQL', urls: [] }
    ])
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.equal((result.stdout.match(/来源 URL 少于 2 条/gu) ?? []).length, 2, result.stdout);
  assert.ok(!/「1 Node\.js」的来源 URL/u.test(result.stdout), result.stdout);
});

test('围栏代码块里的字段不算数 ⇒ exit 1（藏在 ``` 里不能免责）', (t) => {
  const section = [
    '## 1 Node.js',
    '',
    '```markdown',
    ...FIELDS.map(([field, value]) => `- ${field}：${value}`),
    '```',
    '',
    '### 检索来源',
    '',
    `- <${URL_A}> 夹具读数`,
    `- <${URL_B}> 夹具读数`,
    ''
  ];
  const body = [`# ${DAY} 夹具围栏藏字段`, '', ...recordHead(), '', ...section].join('\n');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-fenced-fields.md`]: body });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /缺少字段：现用版本/u);
});

test('HTML 注释里的字段与来源不算数 ⇒ exit 1', (t) => {
  const body = [
    `# ${DAY} 夹具注释藏字段`,
    '',
    ...recordHead(),
    '',
    '## 1 Node.js',
    '',
    '<!-- 草稿：先记在这里',
    ...FIELDS.map(([field, value]) => `- ${field}：${value}`),
    `- <${URL_A}> 夹具读数`,
    `- <${URL_B}> 夹具读数`,
    '-->',
    '',
    '### 检索来源',
    '',
    '（本条未取得来源。）',
    ''
  ].join('\n');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-comment-fields.md`]: body });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /缺少字段：现用版本/u);
  assert.match(result.stdout, /去重后 0 条/u);
});

test('围栏里藏额外来源、正文只有 1 条 ⇒ exit 1（来源不能靠围栏凑数）', (t) => {
  const body = [
    `# ${DAY} 夹具围栏藏来源`,
    '',
    ...recordHead(),
    '',
    `- 来源：${URL_A}`,
    '- 决定：不引入。理由：夹具。',
    '',
    '```text',
    URL_B,
    '```',
    ''
  ].join('\n');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-fenced-sources.md`]: body });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /来源 URL 少于 2 条/u);
});

test('两条 URL 只差 fragment（`#a`／`#b`）⇒ 算 1 条，exit 1', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-fragment.md`]: minimalRecord({ sources: [`${URL_A}#a`, `${URL_A}#b`] })
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /来源 URL 少于 2 条（去重后 1 条）/u);
});

test('`来源版本或提交：1048576` 这种裸 7 位十六进制不算版本 ⇒ exit 1', (t) => {
  const body = minimalRecord().replace('- 来源版本或提交：v24.16.0', '- 来源版本或提交：1048576');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-hex.md`]: body });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /来源版本或提交/u);
});

test('40 位 commit SHA 作来源版本 ⇒ exit 0', (t) => {
  const body = minimalRecord().replace(
    '- 来源版本或提交：v24.16.0',
    '- 来源版本或提交：3b776a8b7bf8fecd9b271f880c549aa5df4f2704'
  );
  const dir = makeWorkspace(t, { [`${DAY}-fixture-sha.md`]: body });
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('紧邻 `commit` 标签的短 SHA 作来源版本 ⇒ exit 0', (t) => {
  const body = minimalRecord().replace('- 来源版本或提交：v24.16.0', '- 来源版本或提交：commit 4ca90d4（夹具）');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-short-sha.md`]: body });
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('最短记录缺「决定」⇒ exit 1', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-no-decision.md`]: minimalRecord().replace('- 决定：不引入。理由：夹具。', '')
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /缺少「决定」/u);
});

test('最短记录的决定没有理由 ⇒ exit 1', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-no-reason.md`]: minimalRecord().replace('- 决定：不引入。理由：夹具。', '- 决定：不引入。')
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /缺少理由/u);
});

test('技术段混入非七项字段名 ⇒ exit 1', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-extra-field.md`]: completeRecord([
      { name: 'Node.js', urls: [URL_A, URL_B], fieldStyle: 'table', extraField: '备注' }
    ])
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /不属于技术七项/u);
});

test('缺少记录级字段「检索日期」⇒ exit 1 且点名该字段', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-no-date.md`]: minimalRecord({ omit: ['检索日期'] })
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /检索日期/u);
});

test('缺少记录级字段「检索方式」⇒ exit 1', (t) => {
  const body = minimalRecord({ omit: ['检索方式'] }).replace(/- 来源：/u, '- 抓取留痕：');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-no-method.md`]: `${body}\n` });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /检索方式/u);
});

test('文件名日期与正文检索日期不一致 ⇒ exit 1', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-mismatch.md`]: minimalRecord().replace(`- 检索日期：${DAY}`, '- 检索日期：2026-10-17')
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /与文件名日期 2026-10-18 不一致/u);
});

test('文件名日期不是真实日历日期 ⇒ exit 1', (t) => {
  const body = minimalRecord().replace(`- 检索日期：${DAY}`, '- 检索日期：2026-02-30');
  const dir = makeWorkspace(t, { '2026-02-30-fixture-bad-date.md': body });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /不是真实日历日期/u);
});

test('「未取得」是 README 允许的取值，不作失败 ⇒ exit 0', (t) => {
  const body = minimalRecord().replace(
    '- 来源版本或提交：v24.16.0',
    '- 来源版本或提交：未取得（上游未发布版本号）'
  );
  const dir = makeWorkspace(t, { [`${DAY}-fixture-undisclosed.md`]: body });
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('未在 allowlist 登记的历史文件 ⇒ exit 1', (t) => {
  const dir = makeWorkspace(t, { [LEGACY_NAME]: LEGACY_BODY });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /未登记的历史文件/u);
});

test('allowlist 登记非 gy-i03-* 的新文件（my-notes.md）⇒ exit 1', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-minimal.md`]: minimalRecord(),
    'my-notes.md': '# 随手记\n\n不是研究记录。\n',
    'legacy-allowlist.json': allowlistJson({ 'my-notes.md': lfSha256('# 随手记\n\n不是研究记录。\n') })
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /只允许登记基线既有的 gy-i03-\*/u);
});

test('legacy 文件登记且未改动 ⇒ exit 0，并计入 legacy（CRLF 检出也认）', (t) => {
  // 故意把夹具写成 CRLF：哈希口径是 LF 归一化，所以同一份内容在 CRLF 与 LF 检出下同值。
  const crlfBody = LEGACY_BODY.replace(/\n/gu, '\r\n');
  const dir = makeWorkspace(t, {
    [LEGACY_NAME]: crlfBody,
    [`${DAY}-fixture-minimal.md`]: minimalRecord(),
    'legacy-allowlist.json': allowlistJson({ [LEGACY_NAME]: lfSha256(LEGACY_BODY) })
  });
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /研究记录校验：1 通过 \/ 0 失败 \/ 1 legacy 已钉住/u);
});

test('legacy 文件被改一个字节 ⇒ exit 1（哈希不一致）', (t) => {
  const dir = makeWorkspace(t, {
    [LEGACY_NAME]: LEGACY_BODY.replace('夹具正文。', '夹具正文!'),
    [`${DAY}-fixture-minimal.md`]: minimalRecord(),
    'legacy-allowlist.json': allowlistJson({ [LEGACY_NAME]: lfSha256(LEGACY_BODY) })
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /内容哈希与 legacy-allowlist\.json 不一致/u);
});

test('allowlist 登记了已不存在的文件 ⇒ exit 1（白名单不得腐烂）', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-minimal.md`]: minimalRecord(),
    'legacy-allowlist.json': allowlistJson({
      'gy-i03-gone-20261011.md': lfSha256('不存在的内容\n')
    })
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /登记的文件不存在/u);
});

test('空目录 ⇒ exit 2（路径写错不能静默通过）', (t) => {
  const dir = makeWorkspace(t, {}, { withReadme: false });
  const result = runGate(dir);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /没有 README\.md/u);
});

test('有 README 但一条记录都没有 ⇒ exit 2', (t) => {
  const dir = makeWorkspace(t, {});
  const result = runGate(dir);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /没有任何研究记录/u);
});

test('目标目录不存在 ⇒ exit 2', () => {
  const result = runGate(join(tmpdir(), 'gy-research-gate-does-not-exist'));
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /目标目录不存在/u);
});

test('多余参数 ⇒ exit 2（口径不明时不猜目录）', () => {
  const result = spawnSync(process.execPath, [GATE, 'docs/research', 'docs'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    windowsHide: true,
    timeout: 30000
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
});

test('仓库真实 docs/research ⇒ exit 0（不许把既有记录打红）', () => {
  const result = runGate(REPO_ROOT, []);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /研究记录校验：3 通过 \/ 0 失败 \/ 4 legacy 已钉住/u);
});

// —— r3 回归：分类与来源范围（审查 c17／c20／c31／c32 的对照组） ——
// 这三条各自锁住一个"越删越绿"的方向：删字段不能降级、段外字段表要认、总览表不能当来源表。

test('完整记录·技术段的七项与「检索来源」子标题一起删掉 ⇒ exit 1（不得降级成最短记录）', (t) => {
  // 审查 c17：七项和 `### 检索来源` 一并删除、只剩两条裸 URL 时，v2 会把它当最短记录放行。
  // 分类按标题形状（`## N <名称>`）前置到记录级，删证据只能让它变红。
  const body = [
    `# ${DAY} 夹具删段记录`,
    '',
    ...recordHead(),
    '',
    '## 1 Node.js',
    '',
    `- ${URL_A}`,
    `- ${URL_B}`,
    '',
    '经比较后决定沿用，理由是零依赖。',
    ''
  ].join('\n');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-strip-section.md`]: body });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /技术项「1 Node\.js」缺少字段：现用版本/u);
});

test('段外独立的 `| 字段 | 含义 |` 表（七项齐全）⇒ exit 0', (t) => {
  // 审查 c20／c31：段外字段表曾被 `[startLine - 1, startLine - 1]` 退化区间排除，恒报缺七项。
  const body = [
    `# ${DAY} 夹具段外字段表`,
    '',
    ...recordHead(),
    '',
    '## 检索',
    '',
    '| 字段 | 含义 |',
    '| --- | --- |',
    ...FIELDS.map(([field, value]) => `| ${field} | ${value} |`),
    '',
    `- 来源：${URL_A}`,
    `- 来源：${URL_B}`,
    ''
  ].join('\n');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-standalone-field-table.md`]: body });
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('带「技术」列的总览表不参与按行来源计数 ⇒ exit 0', (t) => {
  // 审查 c32：v1 形态的总览表（技术｜仓库现用｜上游状态｜决定）曾被逐行核来源而误红。
  const body = [
    `# ${DAY} 夹具总览表`,
    '',
    ...recordHead(),
    `- 来源：${URL_A}`,
    `- 来源：${URL_B}`,
    '',
    '## 总览',
    '',
    '| 技术 | 仓库现用 | 上游状态 | 决定 |',
    '| --- | --- | --- | --- |',
    '| Node.js | v24.16.0 | 活跃 | 复用 |',
    '',
    '## 决定',
    '',
    '复用。理由：夹具。',
    ''
  ].join('\n');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-overview-table.md`]: body });
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// —— r4 回归：豁免必须是锚定白名单、编号分隔符要放宽（审查给的三个 false-pass 向量） ——
// 这三条都是"形状上的小改动能把整个技术段放过去"的方向：豁免词当标题、豁免词当子串、编号带点。

test('技术段标题恰好是「## 1 检索」且无字段 ⇒ exit 1（豁免只认整体等于结构性小节名）', (t) => {
  // 审查向量 v1：子串豁免把「标题里带 检索」的段落当结构性小节，整段 7 项被跳过。
  const body = [
    `# ${DAY} 夹具标题即豁免词`,
    '',
    ...recordHead(),
    '',
    '## 1 检索',
    '',
    `- ${URL_A}`,
    `- ${URL_B}`,
    '',
    '决定：自研。理由：夹具。',
    ''
  ].join('\n');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-heading-exempt-word.md`]: body });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /技术项「1 检索」缺少字段：现用版本/u);
});

test('完整记录内「## 2 Fastify 检索证据」无字段 ⇒ exit 1（豁免词不得作子串命中）', (t) => {
  // 审查向量 v2：第 2 段标题含「检索证据」，子串豁免把它整段放过，按项 ≥2 也没核。
  const body = [
    `# ${DAY} 夹具标题含豁免词`,
    '',
    ...recordHead(),
    '',
    ...techSection(1, 'Node.js', [URL_A, URL_B]),
    '## 2 Fastify 检索证据',
    '',
    '夹具：该段故意不给字段与来源。',
    ''
  ].join('\n');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-heading-contains-exempt.md`]: body });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /技术项「2 Fastify 检索证据」缺少字段：现用版本/u);
  assert.match(result.stdout, /技术项「2 Fastify 检索证据」的来源 URL 少于 2 条/u);
});

test('编号带点分隔符「## 1. Fastify」且无字段 ⇒ exit 1（不得因编号形状漏判）', (t) => {
  // 审查向量 v3：旧正则只认 `1 `，带点编号整段漏判成非技术节。
  const body = [
    `# ${DAY} 夹具点号编号`,
    '',
    ...recordHead(),
    '',
    '## 1. Fastify',
    '',
    `- ${URL_A}`,
    `- ${URL_B}`,
    '',
    '决定：引入。理由：夹具。',
    ''
  ].join('\n');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-dotted-number.md`]: body });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /技术项「1\. Fastify」缺少字段：现用版本/u);
});
