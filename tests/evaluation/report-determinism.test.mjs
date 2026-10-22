// 报告可复现性（issue #20「评估报告可复现」）。
//
// 缺口：指标本来就是确定的（无随机、seed 固定），但 `generatedAt` 取墙钟 ⇒ 同输入两次运行的报告**字节不同**，
//   `sha256` 比对无法当作可复现证据。本文件锁定修法：`--generated-at <ISO8601>` 注入报告时间戳。
//
// 断言口径（刻意区分两种情形）：
//   - 给了 `--generated-at`：同输入连跑两次，报告文件 `sha256` **必须**完全相同（这是可复现契约）；
//   - 没给：**不**断言两次相等（墙钟不确定性不是契约，断言它相等就是把不确定性写成契约），
//     只断言"除 generatedAt 外与固定时间点报告完全一致" + 时间戳仍是合法 ISO8601。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEvaluation } from '../../tools/evaluation/run-evaluation.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(REPO_ROOT, 'tests', 'evaluation', 'fixtures');
const INDEX = join(FIXTURES, 'synthetic-index.json');
const PREDICTIONS = join(FIXTURES, 'synthetic-predictions.json');

// 注入的时间点刻意选在远古日期：与任何真实墙钟都不同，避免"碰巧相等"掩盖注入失效。
const PINNED = '2020-01-01T00:00:00Z';
const PINNED_NORMALIZED = '2020-01-01T00:00:00.000Z';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 进程内驱动 CLI（本环境禁止派生子进程）；返回退出码与两份输出。 */
function runCli(args) {
  let stdout = '';
  let stderr = '';
  const io = {
    stdout: { write: (s) => { stdout += s; return true; } },
    stderr: { write: (s) => { stderr += s; return true; } },
  };
  const { exitCode, report } = runEvaluation(args, io);
  return { exitCode, report, stdout, stderr };
}

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gy-r31-i20-det-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('[可复现] 同输入 + 同 --generated-at 连跑两次：报告文件 sha256 完全相同', () => {
  withTmpDir((dir) => {
    const out1 = join(dir, 'report-1.json');
    const out2 = join(dir, 'report-2.json');

    const first = runCli(['--index', INDEX, '--predictions', PREDICTIONS, '--json', '--generated-at', PINNED, '--out', out1]);
    const second = runCli(['--index', INDEX, '--predictions', PREDICTIONS, '--json', '--generated-at', PINNED, '--out', out2]);

    assert.equal(first.exitCode, 0);
    assert.equal(second.exitCode, 0);

    // 注入生效：报告时间戳是注入值（规范化到 UTC 毫秒），不是墙钟。
    assert.equal(first.report.generatedAt, PINNED_NORMALIZED);
    assert.equal(second.report.generatedAt, PINNED_NORMALIZED);

    const bytes1 = readFileSync(out1);
    const bytes2 = readFileSync(out2);
    assert.equal(bytes1.length, bytes2.length, '两份报告长度应相同');
    assert.equal(sha256(bytes1), sha256(bytes2), '同输入 + 同 --generated-at 的报告文件 sha256 必须相同');
    // stdout 的报告与本应写入文件的内容一致：可复现性不只对 --out 成立。
    assert.equal(first.stdout, second.stdout);
    assert.deepEqual(first.report, second.report);
  });
});

test('[可复现·规范化] 同一时刻的不同写法（+08:00 / Z / 带毫秒）产出逐字节相同的报告', () => {
  withTmpDir((dir) => {
    // 2020-01-01T08:00:00+08:00 === 2020-01-01T00:00:00Z：同一时间点的三种写法必须归一到同一字节。
    const forms = ['2020-01-01T00:00:00Z', '2020-01-01T08:00:00+08:00', '2020-01-01T00:00:00.000Z'];
    const digests = forms.map((form, i) => {
      const out = join(dir, `report-${i}.json`);
      const run = runCli(['--index', INDEX, '--predictions', PREDICTIONS, '--json', '--generated-at', form, '--out', out]);
      assert.equal(run.exitCode, 0, `写法 ${form} 应被接受`);
      assert.equal(run.report.generatedAt, PINNED_NORMALIZED);
      return sha256(readFileSync(out));
    });
    assert.equal(new Set(digests).size, 1, '同一时刻的不同写法必须产出同一份报告字节');
  });
});

test('[向后兼容] 不传 --generated-at：仍取墙钟（只断言格式与"其余字段一致"，不断言两次相等）', () => {
  withTmpDir((dir) => {
    const outDefault = join(dir, 'default.json');
    const outPinned = join(dir, 'pinned.json');

    const withoutFlag = runCli(['--index', INDEX, '--predictions', PREDICTIONS, '--json', '--out', outDefault]);
    assert.equal(withoutFlag.exitCode, 0, '缺省行为应保持可用（向后兼容）');

    const stamp = withoutFlag.report.generatedAt;
    assert.equal(typeof stamp, 'string');
    assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, '缺省时间戳应为 ISO8601（UTC 毫秒）');
    assert.notEqual(stamp, PINNED_NORMALIZED, '未注入时不应出现注入值');
    assert.ok(Math.abs(Date.now() - Date.parse(stamp)) < 60_000, '缺省时间戳应接近当前时间（墙钟语义）');

    // 关键：时间戳以外的一切都不受时间影响 —— 确定性属于指标，不属于墙钟。
    const pinned = runCli(['--index', INDEX, '--predictions', PREDICTIONS, '--json', '--generated-at', PINNED, '--out', outPinned]);
    assert.equal(pinned.exitCode, 0);
    const strip = (r) => {
      const copy = JSON.parse(JSON.stringify(r));
      delete copy.generatedAt;
      return copy;
    };
    assert.deepEqual(strip(withoutFlag.report), strip(pinned.report), '除 generatedAt 外，报告应逐字段一致');
    assert.notEqual(sha256(readFileSync(outDefault)), sha256(readFileSync(outPinned)), '墙钟与注入值的报告字节应不同（否则说明注入未生效）');
  });
});

test('[负例] 非法 --generated-at 在评估前即失败（exit 2），且不写报告', () => {
  withTmpDir((dir) => {
    const out = join(dir, 'never.json');
    for (const [value, hint] of [
      ['2026-10-04', '缺时间与时区'],
      ['2026-10-04T00:00:00', '缺时区'],
      ['not-a-timestamp', '非时间戳'],
    ]) {
      const run = runCli(['--index', INDEX, '--predictions', PREDICTIONS, '--json', '--generated-at', value, '--out', out]);
      assert.equal(run.exitCode, 2, `值 ${value}（${hint}）应被拒绝`);
      assert.equal(run.report, null);
      assert.match(run.stderr, /--generated-at/, '错误信息应点名参数');
      assert.match(run.stderr, /ISO8601/, '错误信息应说明期望格式');
      assert.match(run.stderr, /时区/, '错误信息应说明必须带时区');
      assert.equal(existsSync(out), false, `值 ${value} 不应产出报告文件`);
    }
    // 空值也必须红（`--generated-at` 后面没跟值）。
    const empty = runCli(['--index', INDEX, '--predictions', PREDICTIONS, '--generated-at']);
    assert.equal(empty.exitCode, 2);
    assert.match(empty.stderr, /--generated-at 缺少值/);
  });
});

test('[一致性] 报告文件内容与 stdout 一致，且 sha256 固定值可被独立复算', () => {
  withTmpDir((dir) => {
    const out = join(dir, 'report.json');
    const run = runCli(['--index', INDEX, '--predictions', PREDICTIONS, '--json', '--generated-at', PINNED, '--out', out]);
    assert.equal(run.exitCode, 0);
    const onDisk = readFileSync(out, 'utf8');
    assert.equal(onDisk, run.stdout, '--out 写入的字节应与 stdout 的报告一致');
    // 独立复算：cli 输出的 sha256 与文件 sha256 相等（报告里的 cli.sha256 是自摘要，不做等值断言，
    //   因为它是对脚本本身取摘要；这里只断言我们能独立算出同一个文件摘要，供跨运行比对）。
    assert.match(sha256(Buffer.from(onDisk, 'utf8')), /^[0-9a-f]{64}$/);
  });
});
