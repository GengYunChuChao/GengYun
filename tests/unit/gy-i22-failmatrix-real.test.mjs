/**
 * GY-I22（#22）失败回归矩阵 · loopback 传输臂的单元测试包装（片B）。
 *
 * 与 `gy-i22-failmatrix.test.mjs`（默认进程内 `app.inject` 臂）并列：
 *   - 这里真跑一遍**同一份矩阵**，但走 `--transport=loopback`（`listen(0)` + 全局 `fetch`），
 *     要求退出码 0、`FAIL 0`、条数不少于 `MIN_CASES`，且每条都有**真实读数**；
 *   - 额外断言机读结果里的 `transport` 与 `loopback_origin`，证明真的绑了 127.0.0.1 端口、
 *     真的走 TCP，而不是退化成 `app.inject`。
 *
 * 两条臂共用同一份 `CASES` / `SEAM_CASES` / 期望值，所以「同一矩阵」由完全一致的
 * 族条数 / 批次条数基线（与 `gy-i22-failmatrix.test.mjs` 逐字相同）来钉死。
 *
 * 只跑 harness，不发真实外呼、不碰数据库、不启外部端口（loopback 端口由 runner 自选并即刻关闭）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BATCHES, CASES } from '../failmatrix/cases.mjs';
import { SEAM_CASES } from '../failmatrix/seams.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(ROOT, 'tests', 'failmatrix', 'run.mjs');

/**
 * 本片交付的用例条数下限：与 `gy-i22-failmatrix.test.mjs` 同一基线，只准加、不准删。
 * 168 → 230：异步 AI 域（识别 / OCR / 转写 / 合成 / 作业 / 会话）纳入矩阵。
 */
const MIN_CASES = 230;
/** 每族条数（与 inject 臂同一份用例表，loopback 臂必须逐族一致）。 */
const FAMILY_COUNTS = { C1: 37, C2: 24, C3: 27, C4: 18, C5: 10, C6: 10, C7: 16, D1: 11, D2: 4, D3: 2, D4: 3, E1: 3, E2: 3, C10: 23, C11: 39 };
/** 批次条数（B1 身份与权限面 / B2 媒体、重复请求与无效输入 / B3 审核回调与 AI 失败 / B4 版本回写、注入与媒体凭据 / B5 异步 AI 域游客面与归属面）。 */
const BATCH_COUNTS = { B1: 106, B2: 36, B3: 17, B4: 9, B5: 62 };

function runLoopbackMatrix() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'i22-real-'));
  try {
    const jsonPath = path.join(scratch, 'matrix.json');
    const result = spawnSync(process.execPath, [RUNNER, '--transport=loopback', `--json=${jsonPath}`], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, I22_VERBOSE: '0' },
      timeout: 120_000,
    });
    const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(result.status, 0, `loopback 矩阵应以 0 退出（实际 ${result.status}）：\n${stdout.slice(-6000)}`);
    return JSON.parse(readFileSync(jsonPath, 'utf8'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('GY-I22 失败矩阵 loopback 臂：同一 230 条矩阵走真实 TCP 全绿，且每条都有真实读数', () => {
  const payload = runLoopbackMatrix();

  assert.equal(payload.execution_mode, 'stub');
  assert.equal(payload.transport, 'loopback-http+trusted-seam');
  assert.match(
    payload.loopback_origin ?? '',
    /^http:\/\/127\.0\.0\.1:\d+\/?$/,
    `loopback_origin 必须是真实 127.0.0.1 端口（实际 ${JSON.stringify(payload.loopback_origin)}）`,
  );

  const failing = payload.rows.filter((row) => row.verdict !== 'PASS');
  assert.deepEqual(
    failing.map((row) => `${row.id} ${row.path} → ${JSON.stringify(row.actual)}：${row.problems.join('；')}`),
    [],
    'loopback 臂里出现了 FAIL',
  );

  assert.ok(
    payload.totals.total >= MIN_CASES,
    `条数 ${payload.totals.total} 少于基线 ${MIN_CASES}（用例被删了？）`,
  );
  assert.equal(payload.totals.fail, 0);
  assert.equal(payload.totals.pass, payload.totals.total);
  assert.equal(
    payload.totals.total,
    CASES.length + SEAM_CASES.length,
    'loopback 臂必须跑满同一份全量矩阵（HTTP + seam），不得是子集',
  );

  for (const row of payload.rows) {
    // seam 用例没有 HTTP 状态码：它的读数是**回调 / 筛查结论码**，同样必须非空。
    if (row.method === 'SEAM') {
      assert.equal(typeof row.actual?.code, 'string', `${row.id} 缺 actual.code 真实读数`);
      assert.ok(row.actual.code.length > 0, `${row.id} 的结论码是空串`);
      continue;
    }
    const single = !Array.isArray(row.actual);
    const readings = single ? [row.actual] : row.actual;
    for (const reading of readings) {
      assert.equal(typeof reading.status, 'number', `${row.id} 缺 actual.status 真实读数`);
      assert.ok(reading.status >= 100 && reading.status <= 599, `${row.id} 的 status 读数不合理：${reading.status}`);
    }
  }

  for (const [family, expected] of Object.entries(FAMILY_COUNTS)) {
    assert.equal(payload.families[family]?.total, expected, `${family} 条数与基线不一致`);
    assert.equal(payload.families[family]?.fail, 0, `${family} 有失败`);
  }

  for (const [batch, expected] of Object.entries(BATCH_COUNTS)) {
    const spec = BATCHES.find((one) => one.id === batch);
    assert.ok(spec !== undefined, `批次 ${batch} 不在用例表里`);
    const total = payload.rows.filter((row) => spec.families.includes(row.family)).length;
    assert.equal(total, expected, `批次 ${batch} 条数与基线不一致`);
  }
});
