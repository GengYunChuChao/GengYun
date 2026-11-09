/**
 * `tools/demo-stack.mjs` 的**真仓 CLI 契约**：只跑不碰 PG、不碰端口的子命令，断言退出码与三行结论。
 *
 * 为什么与 `tests/unit/demo-stack.test.mjs` 分家：那份文件只测 `tools/lib/demo-stack.mjs` 的纯函数
 * （参数解析、env 组装、健康轮询、错误分类），一条真进程都不起；这里补的是「命令行入口本身」——
 * 帮助与状态查询走的是真 spawn，`tools/` 接线元闸门（`tests/unit/ci-orphan-tools-wired.test.mjs`）
 * 认的正是「在仓库根 spawn + 站点级 `.status` 断言」这种证据。
 *
 * ⛔ 不在这里起 PG：`status` 只读 `state.json`、探端口、探 `/health`，没有 `up` 的写路径。
 * 真起栈的验收在 `docs/verification/gy-r90-demo-stack-20261109.md` 里，用真 PG 17 跑。
 */
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = join(ROOT, 'tools', 'demo-stack.mjs');

/** 一个空状态目录：让 status 看不到任何 pid/state，结论只能是「未运行」。 */
function withTempStateDir(run) {
  const stateDir = mkdtempSync(join(tmpdir(), 'gy-demo-stack-cli-'));
  try {
    return run(stateDir);
  } finally {
    rmSync(stateDir, {recursive: true, force: true});
  }
}

test('demo-stack.mjs --help：exit 0，且五个子命令都在用法里', () => {
  const result = spawnSync(process.execPath, [TOOL, '--help'], {cwd: ROOT, encoding: 'utf8', timeout: 30_000});
  assert.equal(result.status, 0, `--help 应 exit 0，实际 ${result.status}\n${result.stderr}`);
  for (const command of ['up', 'down', 'status', 'logs', 'reset']) {
    assert.match(result.stdout, new RegExp(`^\\s+${command}\\s`, 'm'), `用法里缺子命令 ${command}`);
  }
  assert.match(result.stdout, /--env-file/, '用法里缺 --env-file');
  assert.match(result.stdout, /--demo/, '用法里缺 --demo');
  assert.match(result.stdout, /--seed-demo/, '用法里缺 --seed-demo（演示资料开关默认关闭，必须写出来）');
  assert.match(result.stdout, /非生产数据/, '--seed-demo 的用法必须点明灌的是演示资料、不是生产数据');
});

test('demo-stack.mjs status：空状态目录下 exit 0，三行结论齐全且都说「未运行」', () => {
  withTempStateDir((stateDir) => {
    const result = spawnSync(
      process.execPath,
      [TOOL, 'status', '--state-dir', stateDir, '--port', '38111', '--pg-port', '55511'],
      {cwd: ROOT, encoding: 'utf8', timeout: 60_000},
    );
    assert.equal(result.status, 0, `status 应 exit 0，实际 ${result.status}\n${result.stderr}`);
    const lines = result.stdout.split(/\r?\n/u).filter((line) => line !== '');
    assert.match(lines[0], /^进程：/, `第一行应是进程结论，实际 ${lines[0]}`);
    assert.match(lines[1], /^端口：/, `第二行应是端口结论，实际 ${lines[1]}`);
    assert.match(lines[2], /^健康：/, `第三行应是健康结论，实际 ${lines[2]}`);
    assert.match(lines[0], /未运行/, '空状态目录里 API 不该显示在跑');
    assert.match(lines[1], /空闲/, '没人监听的端口应报空闲');
    assert.doesNotMatch(result.stdout, /pid 文件还在/, '空状态目录不该冒出陈旧 pid 结论');
  });
});

test('demo-stack.mjs 未知参数 / 未知子命令：exit 1 且点名错在哪', () => {
  const unknownFlag = spawnSync(process.execPath, [TOOL, 'status', '--nope'], {cwd: ROOT, encoding: 'utf8', timeout: 30_000});
  assert.equal(unknownFlag.status, 1, `未知参数应 exit 1，实际 ${unknownFlag.status}`);
  assert.match(unknownFlag.stderr, /未知参数「--nope」/, '未知参数要点名');

  const unknownCommand = spawnSync(process.execPath, [TOOL, 'restart'], {cwd: ROOT, encoding: 'utf8', timeout: 30_000});
  assert.equal(unknownCommand.status, 1, `未知子命令应 exit 1，实际 ${unknownCommand.status}`);
  assert.match(unknownCommand.stderr, /未知子命令「restart」/, '未知子命令要点名');
});
