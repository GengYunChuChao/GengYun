/**
 * GY-I22（#22）失败回归矩阵 · 单元测试包装。
 *
 * 这套用例把 `tests/failmatrix/` 的 harness 接进 `npm run test:unit` 与 CI：
 *   - 真跑一遍全矩阵（进程内 `app.inject`，`execution_mode=stub`），要求退出码 0、`FAIL 0`、
 *     条数不少于 `MIN_CASES`，且每一条都有**真实读数**（`actual.status` 为数字）；
 *   - 静态校验负控制清单与当前产品代码仍然对得上（每处 `find` 在文件里恰好出现一次）。
 *     `find` 一旦对不上，说明守卫被重构而负控制失效——这条必须比矩阵更早红。
 *
 * 只跑 harness，不发真实外呼、不碰数据库、不启端口。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BATCHES, CASES, FAMILIES } from '../failmatrix/cases.mjs';
import { MUTATIONS } from '../failmatrix/mutations.mjs';
import { SEAM_CASES, SEAM_FAMILIES } from '../failmatrix/seams.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(ROOT, 'tests', 'failmatrix', 'run.mjs');

/**
 * 本片交付的用例条数下限：只准加、不准在没人注意时被删。
 *
 * 168 → 230：本轮把异步 AI 域（识别 / OCR / 转写 / 合成 / 作业 / 会话共 23 个 operation）
 * 拉进矩阵——C10 游客面 23 条（每个 operation 无凭据必须 401 SESSION_REQUIRED）、
 * C11 归属面 39 条（17 对「他人资源 404 / 不存在 404 同形」+ 5 条越权写之后的属主正控制）。
 * 168 + 23 + 39 = 230；只增不减。
 */
const MIN_CASES = 230;
/** 每族条数（本片实跑快照：C/E 族走 HTTP，D 族走受信 seam）。 */
const FAMILY_COUNTS = { C1: 37, C2: 24, C3: 27, C4: 18, C5: 10, C6: 10, C7: 16, D1: 11, D2: 4, D3: 2, D4: 3, E1: 3, E2: 3, C10: 23, C11: 39 };
/** 批次条数（B1 身份与权限面 / B2 媒体、重复请求与无效输入 / B3 审核回调与 AI 失败 / B4 版本回写、注入与媒体凭据 / B5 异步 AI 域游客面与归属面）。 */
const BATCH_COUNTS = { B1: 106, B2: 36, B3: 17, B4: 9, B5: 62 };

function runMatrix() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'i22-unit-'));
  try {
    const jsonPath = path.join(scratch, 'matrix.json');
    const result = spawnSync(process.execPath, [RUNNER, `--json=${jsonPath}`], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, I22_VERBOSE: '0' },
    });
    const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(result.status, 0, `矩阵应以 0 退出（实际 ${result.status}）：\n${stdout.slice(-6000)}`);
    return JSON.parse(readFileSync(jsonPath, 'utf8'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('GY-I22 失败矩阵：全量真跑 230 条全绿，且每条都有真实读数', () => {
  const payload = runMatrix();

  assert.equal(payload.execution_mode, 'stub');
  assert.equal(payload.transport, 'app.inject+trusted-seam');

  const failing = payload.rows.filter((row) => row.verdict !== 'PASS');
  assert.deepEqual(
    failing.map((row) => `${row.id} ${row.path} → ${JSON.stringify(row.actual)}：${row.problems.join('；')}`),
    [],
    '矩阵里出现了 FAIL',
  );

  assert.ok(
    payload.totals.total >= MIN_CASES,
    `条数 ${payload.totals.total} 少于基线 ${MIN_CASES}（用例被删了？）`,
  );
  assert.equal(payload.totals.fail, 0);
  assert.equal(payload.totals.pass, payload.totals.total);

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

test('GY-I22 失败矩阵：用例表自洽（id 唯一、族/批次闭合、expect 齐备）', () => {
  const ids = new Set();
  for (const one of CASES) {
    // C1..C7 + C10/C11（异步 AI 域 2026-10 纳入：游客面与归属面）+ E1/E2。
    assert.match(one.id, /^C(?:[1-7]|1[01])-\d{2}$|^E[12]-\d{2}$/, `用例 id 形状不对：${one.id}`);
    assert.ok(!ids.has(one.id), `用例 id 重复：${one.id}`);
    ids.add(one.id);
    assert.ok(FAMILIES[one.family] !== undefined, `${one.id} 的族 ${one.family} 没有说明`);
    assert.ok(
      BATCHES.some((batch) => batch.families.includes(one.family)),
      `${one.id} 的族 ${one.family} 没归到任何批次`,
    );
    assert.equal(typeof one.method, 'string');
    assert.equal(typeof one.path === 'string' || typeof one.path === 'function', true, `${one.id} 缺 path`);
    assert.equal(typeof one.expect?.status, 'number', `${one.id} 缺 expect.status`);
    if (one.check !== undefined) assert.equal(typeof one.check, 'function');
  }

  for (const one of SEAM_CASES) {
    assert.match(one.id, /^D[1-4]-\d{2}$/, `seam 用例 id 形状不对：${one.id}`);
    assert.ok(!ids.has(one.id), `用例 id 重复：${one.id}`);
    ids.add(one.id);
    assert.ok(SEAM_FAMILIES[one.family] !== undefined, `${one.id} 的族 ${one.family} 没有说明`);
    assert.ok(
      BATCHES.some((batch) => batch.families.includes(one.family)),
      `${one.id} 的族 ${one.family} 没归到任何批次`,
    );
    assert.equal(typeof one.invoke, 'function', `${one.id} 缺 invoke`);
    assert.equal(typeof one.expect?.code, 'string', `${one.id} 缺 expect.code`);
    if (one.check !== undefined) assert.equal(typeof one.check, 'function');
  }

  // seam 用例族不进 HTTP 表：总条数按两侧相加核对。
  assert.equal(CASES.length + SEAM_CASES.length, MIN_CASES);
});

test('GY-I22 负控制清单与当前产品代码同步（每条 find 恰好命中一次）', () => {
  assert.ok(MUTATIONS.length >= 20, `负控制只剩 ${MUTATIONS.length} 条（基线 20 条）`);
  const seen = new Set();
  for (const mutation of MUTATIONS) {
    assert.ok(!seen.has(mutation.id), `负控制 id 重复：${mutation.id}`);
    seen.add(mutation.id);
    assert.ok(mutation.watch.length > 0, `${mutation.id} 没有 watch 用例`);
    const editList = mutation.edits ?? [{ file: mutation.file, find: mutation.find, replace: mutation.replace }];
    for (const edit of editList) {
      assert.equal(typeof edit.file, 'string', `${mutation.id} 缺 file`);
      const text = readFileSync(path.join(ROOT, edit.file), 'utf8');
      const occurrences = text.split(edit.find).length - 1;
      assert.equal(
        occurrences,
        1,
        `${mutation.id} 的 find 在 ${edit.file} 命中 ${occurrences} 次（必须恰好 1 次）：守卫被重构了？`,
      );
      assert.notEqual(edit.find, edit.replace, `${mutation.id} 的 find/replace 相同（等于没改）`);
    }
    // watch 里的用例必须真的存在于用例表。
    for (const id of mutation.watch) assert.ok(ids().has(id), `${mutation.id} 的 watch 含不存在的用例 ${id}`);
  }

  function ids() {
    return new Set([...CASES.map((one) => one.id), ...SEAM_CASES.map((one) => one.id)]);
  }
});
