/**
 * GY-I24 交付材料索引 · 回归：门禁工具可跑、索引与仓库事实一致。
 *
 * 分层：
 *   1. 门禁工具 `tools/verify-release-materials.mjs` 实跑退出码 0、无 FAIL 行；
 *   2. 索引声明的**当前读数**与文件系统一致（迁移数／down 数／deploy 文件数）——
 *      仓库事实前进（如新增迁移）而索引没更新时，本文件先红，逼着同步索引；
 *   3. 索引必须载明边界（Refs #24、不关闭整项、离线核验不代表验收）。
 *
 * 边界：本文件不部署、不连云、不连库；只读仓库事实。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX = 'docs/verification/gy-i24-release-materials-index-20261017.md';
const TOOL = 'tools/verify-release-materials.mjs';
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('门禁·离线核验工具实跑通过（退出码 0、无 FAIL）', () => {
  const run = spawnSync(process.execPath, [TOOL], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, `工具退出码必须为 0\n${run.stdout}\n${run.stderr}`);
  assert.equal(/^FAIL/m.test(run.stdout), false, '不得有 FAIL 行');
  const passCount = (run.stdout.match(/^PASS/gm) || []).length;
  assert.ok(passCount >= 10, `至少 10 项 PASS，实际 ${passCount}`);
  assert.match(run.stdout, /离线文档核验；不代表部署、云端或运行期已验收/, '汇总行必须声明不代表验收');
});

test('索引·当前读数与文件系统一致（迁移/down/deploy 文件数）', () => {
  const migrations = readdirSync(join(ROOT, 'services/api/db/migrations'))
    .filter((n) => /^\d{4}_.*\.sql$/.test(n));
  const downs = readdirSync(join(ROOT, 'services/api/db/migrations/rollback'))
    .filter((n) => /^\d{4}_.*\.down\.sql$/.test(n));
  const deployFiles = spawnSync('git', ['ls-files', 'deploy'], { cwd: ROOT, encoding: 'utf8' })
    .stdout.split('\n').filter((s) => s.trim() !== '');

  const index = read(INDEX);
  // 索引必须写明当前数量（写成长文档句，允许灵活表述，但数字必须在）
  assert.ok(index.includes(`**${migrations.length}** 个`) || index.includes(`${migrations.length} 个`),
    `索引必须写明当前迁移数 ${migrations.length}`);
  assert.ok(index.includes(`${downs.length} 个`), `索引必须写明当前 down 数 ${downs.length}`);
  assert.ok(index.includes(`${deployFiles.length} 个文件全部在索引表行中`) || index.includes(`${deployFiles.length}/29`),
    `索引必须与 deploy 在册文件数 ${deployFiles.length} 一致`);
  // 结构性不变量：down 覆盖 0002..N、无 0001
  assert.equal(downs.some((n) => n.startsWith('0001_')), false, '不得存在 0001 的 down 脚本');
  assert.equal(downs.length, migrations.length - 1, 'down 数必须等于迁移数减一（无 0001）');
});

test('门禁·bash 调用不得传入文件路径（Windows/WSL 路径解释分歧的根因）', () => {
  // 监工在 WSL 下实测：把 join(ROOT, script) 的 Windows 路径传给 bash -n，5/5 「找不到文件」
  // （MSYS bash 吃 D:\…、WSL 只吃 /mnt/d/…、Linux CI 吃 /…）。修法是把 blob 内容喂 stdin。
  // 本条把该形态钉住：工具里对 bash 的调用只能是 ['-n'] + input，不得出现路径参数。
  const source = read(TOOL);
  assert.ok(/execFileSync\('bash',\s*\['-n'\],\s*\{\s*input:/.test(source),
    'bash -n 必须改用 stdin 喂入（blob 内容），不得传文件路径');
  assert.equal(/execFileSync\('bash',\s*\['-n',/.test(source), false,
    '不得再给 bash 传文件路径参数');
  assert.ok(/git cat-file blob/.test(source) || /cat-file/.test(source),
    '语法检查的内容必须取自提交 blob（与 LF 判据同源，避免工作区 CRLF 假红）');
});

test('索引·载明边界：Refs #24、不关闭整项、离线核验不代表验收', () => {
  const index = read(INDEX);
  assert.ok(index.includes('Refs #24'), '必须使用 Refs #24');
  assert.ok(index.includes('不关闭整项'), '必须声明不关闭整项 issue');
  assert.ok(index.includes('未推送、未建 PR、未改 main'), '必须声明写手边界');
  assert.ok(index.includes('离线核验**不能**覆盖') || index.includes('离线核验不能覆盖'), '必须列出离线不能覆盖项');
  // 误报排除的教训必须留在文档里（autocrlf 工作区假象）
  assert.ok(index.includes('core.autocrlf'), '必须记录 LF 判据查 blob 的原因');
});
