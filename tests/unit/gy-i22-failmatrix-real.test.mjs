/**
 * GY-I22（#22）失败回归矩阵 · **真实 PostgreSQL 17 运行臂**的单元测试包装。
 *
 * 这组测试**不碰真库**（不需要 GY_PG_BIN），只锁住 `run-real.mjs` 的两条**闸门契约**：
 *   1) 没有 `GY_PG_BIN` 时必须退出 **77**（POSIX「skipped」＝未取得，⛔ 不是通过），
 *      并显式打印「未取得，不是通过」；只有显式 `--allow-skip` / `GY_ALLOW_SKIP=1` 才降级为 0；
 *   2) 权限面覆盖范围与 stub 用例表同源（C1–C4 / C10 / C11，共 168 条），不另写一套用例。
 *
 * 为什么只锁闸门、不锁「全绿」：真 PG 臂的价值是**逐条记录 stub 期望 vs 真 PG 实际的差异**
 * （real 模式下 media / 社区投稿 / 异步 AI 作业 / 注销受理等域 fail-closed，会真实地产生 503/403/200
 * 的差异），它**不要求 168 条在真库上全绿**——那正是 `run.mjs`（stub 臂）的职责。真 PG 读数由
 * `tests/failmatrix/run-real.mjs` 在有 `GY_PG_BIN` 的本机实跑取得，证据见 README。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CASES, FAMILIES } from '../failmatrix/cases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN_REAL = path.join(ROOT, 'tests', 'failmatrix', 'run-real.mjs');

/** 真 PG 臂覆盖的权限面族（与 README 的「至少 C1-C4/C10/C11」一致）。 */
const PERMISSION_FAMILIES = ['C1', 'C2', 'C3', 'C4', 'C10', 'C11'];

/** 抹掉本机可能泄漏的 PG 环境变量，确保测的是「缺 GY_PG_BIN」这条真实路径。 */
function runReal(args = []) {
  const env = { ...process.env };
  delete env.GY_PG_BIN;
  delete env.GY_I22_PG_ROOT;
  delete env.GY_ALLOW_SKIP;
  return spawnSync(process.execPath, [RUN_REAL, ...args], { cwd: ROOT, encoding: 'utf8', env });
}

test('GY-I22 真 PG 臂：缺 GY_PG_BIN 退出 77（未取得，不是通过），不得伪装 PASS', () => {
  const result = runReal();
  const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(
    result.status,
    77,
    `缺 GY_PG_BIN 必须退出 77（未取得），实际 ${result.status}：\n${stdout.slice(-3000)}`,
  );
  assert.match(stdout, /未取得/);
  assert.match(stdout, /不是通过/);
  assert.match(stdout, /GY_PG_BIN/);
  // 没有显式 --allow-skip / GY_ALLOW_SKIP=1 时，绝不降级成 0。
  assert.doesNotMatch(stdout, /EXITCODE=0/);
});

test('GY-I22 真 PG 臂：只有显式 --allow-skip 才把「未取得」降级为 0（本机开发专用，⛔ 不得接门禁）', () => {
  const result = runReal(['--allow-skip']);
  const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `--allow-skip 应显式降级为 0，实际 ${result.status}：\n${stdout.slice(-2000)}`);
  assert.match(stdout, /EXITCODE=0/);
});

test('GY-I22 真 PG 臂：权限面覆盖范围与 stub 用例表同源（C1–C4/C10/C11，168 条，不另写一套用例）', () => {
  for (const family of PERMISSION_FAMILIES) {
    assert.ok(FAMILIES[family] !== undefined, `权限面族 ${family} 不在 stub 用例表 FAMILIES 里`);
  }
  const permissionCases = CASES.filter((one) => PERMISSION_FAMILIES.includes(one.family));
  assert.equal(permissionCases.length, 168, '权限面 C1–C4/C10/C11 必须是 168 条（与 stub 用例表同源）');
});
