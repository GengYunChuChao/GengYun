/**
 * `tools/verify-research-records.mjs` 的判据测试。
 *
 * 为什么需要它：`npm run test:docs` 里那条命令一旦被判据写松（比如少写一项、
 * 一条来源、日期只写在文件名里也放过），**它自己不会红**——只会静默变绿。
 * 本文件用**临时目录夹具**逐条证明每个判据真的会触发，并证明合规记录不会被误判。
 *
 * 边界：⛔ 不触碰仓库内真实 `docs/`（只读 `tools/` 下被测脚本）；⛔ 不联网；
 * 夹具全部写在 `os.tmpdir()` 下并在用例结束时删除。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（tests/unit/ → ../..），⛔ 不用 process.cwd()。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GATE = join(REPO_ROOT, 'tools', 'verify-research-records.mjs');

/** 夹具固定日期（真实日历日），⛔ 不取 `new Date()`，否则用例随日期漂移。 */
const DAY = '2026-10-18';
const URL_TEST_DOC = 'https://nodejs.org/api/test.html';
const URL_RELEASES = 'https://nodejs.org/en/about/previous-releases';
const LEGACY_NAME = 'gy-i03-fixture-20261011.md';
const LEGACY_BODY = '# 夹具 legacy 记录\n\n夹具正文。\n';

const lfSha256 = (text) =>
  createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

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
function runGate(dir) {
  const result = spawnSync(process.execPath, [GATE, dir], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    windowsHide: true,
    timeout: 30000
  });
  assert.equal(result.error, undefined, `子进程未启动：${result.error?.message ?? ''}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** README §7 的"最短记录"夹具；`omit` 用于注入缺项。 */
function recordText({ date = DAY, omit = [], sources = [URL_TEST_DOC, URL_RELEASES] } = {}) {
  const lines = [`# ${DAY} 夹具记录`, '', '范围：夹具。', '', '## 检索', ''];
  if (!omit.includes('检索日期')) lines.push(`- 检索日期：${date}。`);
  if (!omit.includes('检索方式')) lines.push('- 检索方式：直接抓取官方页，未使用检索词。');
  if (!omit.includes('来源版本或提交')) lines.push('- 来源版本或提交：v24.16.0（夹具）。');
  lines.push('', '## 来源（均已实际打开）', '');
  for (const url of sources) lines.push(`- ${url} —— 夹具读数。`);
  lines.push('', '## 决定', '', '**自研。** 理由：夹具。', '');
  return lines.join('\n');
}

/** 带技术七项字段表的夹具；`drop` 传字段名即可抽掉一行。 */
function recordWithFieldTable(drop = null) {
  const fields = [
    ['现用版本（证据命令）', '`node --version` ⇒ v24.16.0'],
    ['上游维护状态', '活跃'],
    ['可复用部分', '全部内置模块'],
    ['许可证与署名', 'MIT'],
    ['兼容性', 'Node 24'],
    ['引入成本', '0 个新依赖'],
    ['决定', '自研']
  ].filter(([name]) => name !== drop);
  return [
    recordText(),
    '## 技术字段表',
    '',
    '| 项 | 内容 |',
    '| --- | --- |',
    ...fields.map(([name, value]) => `| ${name} | ${value} |`),
    ''
  ].join('\n');
}

test('合格的最短记录 ⇒ exit 0，并逐条打印 PASS 与统计', (t) => {
  const dir = makeWorkspace(t, { [`${DAY}-fixture-minimal.md`]: recordText() });
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS 2026-10-18-fixture-minimal\.md/u);
  assert.match(result.stdout, /研究记录校验：1 通过 \/ 0 失败 \/ 0 legacy 已钉住/u);
});

test('带技术七项字段表的记录 ⇒ exit 0（七项齐全时不误伤）', (t) => {
  const dir = makeWorkspace(t, { [`${DAY}-fixture-fields.md`]: recordWithFieldTable() });
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('非字段表（总览表）不得被误判为技术字段表 ⇒ exit 0', (t) => {
  const overview = [
    recordText(),
    '## 总览',
    '',
    '| 技术 | 仓库现用 | 上游状态 | 决定 |',
    '| --- | --- | --- | --- |',
    '| Node.js | v24.16.0 | 活跃 | 复用 |',
    ''
  ].join('\n');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-overview.md`]: overview });
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('缺少记录级字段「检索日期」⇒ exit 1 且点名该字段', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-no-date.md`]: recordText({ omit: ['检索日期'] })
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /检索日期/u);
});

test('缺少记录级字段「来源版本或提交」⇒ exit 1 且点名该字段', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-no-version.md`]: recordText({ omit: ['来源版本或提交'] })
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /来源版本或提交/u);
});

test('来源只有 1 条 URL ⇒ exit 1', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-one-source.md`]: recordText({ sources: [URL_TEST_DOC] })
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /来源 URL 少于 2 条/u);
});

test('两条 URL 完全相同（不互不相同）⇒ exit 1', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-dup-source.md`]: recordText({ sources: [URL_TEST_DOC, URL_TEST_DOC] })
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /来源 URL 少于 2 条/u);
});

test('文件名日期与正文检索日期不一致 ⇒ exit 1', (t) => {
  const dir = makeWorkspace(t, { [`${DAY}-fixture-mismatch.md`]: recordText({ date: '2026-10-17' }) });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /与文件名日期 2026-10-18 不一致/u);
});

test('文件名日期不是真实日历日期 ⇒ exit 1', (t) => {
  const dir = makeWorkspace(t, { '2026-02-30-fixture-bad-date.md': recordText({ date: '2026-02-30' }) });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /不是真实日历日期/u);
});

test('技术字段表缺「引入成本」⇒ exit 1 且点名该字段', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-missing-cost.md`]: recordWithFieldTable('引入成本')
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /缺少：引入成本/u);
});

test('技术字段表里混入非七项字段名 ⇒ exit 1', (t) => {
  const body = recordWithFieldTable().replace('| 决定 | 自研 |', '| 决定 | 自研 |\n| 备注 | 夹具 |');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-extra-field.md`]: body });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /「备注」不是技术七项之一/u);
});

test('未在 allowlist 登记的历史文件 ⇒ exit 1', (t) => {
  const dir = makeWorkspace(t, { [LEGACY_NAME]: LEGACY_BODY });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /未登记的历史文件/u);
});

test('legacy 文件登记且未改动 ⇒ exit 0，并计入 legacy（CRLF 检出也认）', (t) => {
  // 故意把夹具写成 CRLF：哈希口径是 LF 归一化，所以同一份内容在 CRLF 与 LF 检出下同值。
  const crlfBody = LEGACY_BODY.replace(/\n/g, '\r\n');
  const dir = makeWorkspace(t, {
    [LEGACY_NAME]: crlfBody,
    [`${DAY}-fixture-minimal.md`]: recordText(),
    'legacy-allowlist.json': allowlistJson({ [LEGACY_NAME]: lfSha256(LEGACY_BODY) })
  });
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /研究记录校验：1 通过 \/ 0 失败 \/ 1 legacy 已钉住/u);
});

test('legacy 文件被改一个字节 ⇒ exit 1（哈希不一致）', (t) => {
  const dir = makeWorkspace(t, {
    [LEGACY_NAME]: LEGACY_BODY.replace('夹具正文。', '夹具正文!'),
    [`${DAY}-fixture-minimal.md`]: recordText(),
    'legacy-allowlist.json': allowlistJson({ [LEGACY_NAME]: lfSha256(LEGACY_BODY) })
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /内容哈希与 legacy-allowlist\.json 不一致/u);
});

test('allowlist 登记了已不存在的文件 ⇒ exit 1（白名单不得腐烂）', (t) => {
  const dir = makeWorkspace(t, {
    [`${DAY}-fixture-minimal.md`]: recordText(),
    'legacy-allowlist.json': allowlistJson({ 'gy-i03-gone-20261011.md': lfSha256('不存在的内容\n') })
  });
  const result = runGate(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /登记的文件不存在/u);
});

test('「未取得」是 README 允许的取值，不作失败 ⇒ exit 0', (t) => {
  const body = recordText()
    .replace('- 来源版本或提交：v24.16.0（夹具）。', '- 来源版本或提交：未取得（上游未发布版本号）。')
    .replace('## 决定', '## 上游维护状态\n\n- 上游维护状态：未取得（仓库无 release 记录）。\n\n## 决定');
  const dir = makeWorkspace(t, { [`${DAY}-fixture-undisclosed.md`]: body });
  const result = runGate(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
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
