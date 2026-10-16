/**
 * GY-I16 私有可见性回归的**反向控制**运行器（不属于 `test:integration:http` 门禁名单，需显式运行）。
 *
 * 目的：证明 `favorites-history-isolation-http.mjs` 的隔离/越权断言不是空的（防假绿）。
 *
 * 手法：**同一份未改动的脚本、同一套断言**，只把内置开关 `GY_I16_SWAP_B_TO_A=1` 打开
 * （把"会话 B"换成会话 A 的凭据与主体），要求脚本**必定变红**且恰好红在私有隔离断言上。
 * 不做任何复制/文本改写（复制品会因相对导入 `../../services/...` 解析失败而**假红**）。
 * 运行前后用 `git hash-object`（blob 指纹）、逐字节读回与 `git status --porcelain` 自证原文件未变；
 * ⛔ 不做 PowerShell `Get-Content | Set-Content` 文本往返。
 *
 * 用法（在 worktree 根）：`node tests/integration/favorites-history-isolation-http.reverse-control.mjs`
 * 退出码：0 = 反向控制成立（已变红、且红在预期断言、且原文件未变）；1 = 控制不成立或文件被改动。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = 'tests/integration/favorites-history-isolation-http.mjs';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(args) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} 失败：${result.stderr}`);
  return result.stdout;
}

function note(kind, text) {
  console.log(`[GY-I16-REVERSE] ${kind} ${text}`);
}

const blobBefore = git(['hash-object', SCRIPT]).trim();
const bytesBefore = readFileSync(join(repoRoot, SCRIPT));
const statusBefore = git(['status', '--porcelain']).trim();
note('baseline', `原脚本 blob=${blobBefore}；git status 条目数=${statusBefore === '' ? 0 : statusBefore.split('\n').length}`);

note('run', '反向控制：GY_I16_SWAP_B_TO_A=1（会话 B ← 会话 A），脚本与断言一字未改');
const child = spawnSync(process.execPath, [join(repoRoot, SCRIPT)], {
  cwd: repoRoot,
  env: { ...process.env, GY_I16_SWAP_B_TO_A: '1' },
  encoding: 'utf8',
});
const combined = `${child.stdout ?? ''}${child.stderr ?? ''}`;
console.log('----- 反向控制原始输出（stdout+stderr，未删改）-----');
console.log(combined.trimEnd());
console.log('----- 原始输出结束 -----');
note('exit', `退出码=${child.status}（期望非 0）`);

assert.notEqual(child.status, 0, '反向控制必须让脚本变红（退出码非 0）');
assert.ok(combined.includes('[GY-I16-E2E] FAIL'), '反向控制输出必须包含失败标记 [GY-I16-E2E] FAIL');
assert.ok(
  combined.includes('私有隔离：B 的列表不得看到 A 的收藏'),
  '反向控制必须恰好红在私有隔离断言上（而不是夹具装配失败或环境问题）',
);

// 原文件自证：blob 指纹、字节、工作树状态三项全等。
const blobAfter = git(['hash-object', SCRIPT]).trim();
const statusAfter = git(['status', '--porcelain']).trim();
assert.equal(blobAfter, blobBefore, `原脚本 blob 指纹必须不变（前=${blobBefore} 后=${blobAfter}）`);
assert.deepEqual(readFileSync(join(repoRoot, SCRIPT)), bytesBefore, '原脚本字节必须不变');
assert.equal(statusAfter, statusBefore, `工作树状态必须不变（前=${JSON.stringify(statusBefore)} 后=${JSON.stringify(statusAfter)}）`);
note('proven', `原文件未改动：blob ${blobBefore}（前=后）；逐字节一致；git status 未变化`);

console.log('PASS favorites-history-isolation-http.reverse-control; swapped session B to A ⇒ assertions went red on the isolation assertion; original file unchanged (blob + bytes + git status)');
process.exit(0);
