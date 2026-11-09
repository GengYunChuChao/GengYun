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
 *
 * 「已就绪但缺批准」的用例（演示栈 B2 回归）用**假 API**：一个只回 `/health` 200 的 `node -e`
 * 进程，命令行里带 `--gy-demo-stack-instance=…`（可选 `--approve-real-media-wiring`），pid 文件由
 * 用例自己写。这样短路口径是真的 spawn 真仓 CLI，但不需要 PG、也不往真状态目录里写东西。
 */
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {connect, createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import test from 'node:test';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {INSTANCE_FLAG, buildPidRecord} from '../../tools/lib/demo-stack.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = join(ROOT, 'tools', 'demo-stack.mjs');
const WIN = process.platform === 'win32';
/** 「这是不是本工具起的实例」靠端口探测拿到 pid + 命令行；只有 Windows 的探测才会点名命令行。 */
const NEEDS_COMMAND_LINE = WIN ? false : '仅 Windows：probePort 才能从端口反查 pid 与命令行，短路口径才认得自己的实例';

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

// ── 假 API：只把短路口径需要的两件事做实（占着端口、命令行带实例标记）────────────
// 为什么不用真 API：短路口径只探端口 + 命令行 + /health，真服务要 PG + env；用 node -e 伪造
// 一个只回 /health 的进程，既走真 spawn 真仓 CLI，又不碰 PG、不写任何真状态目录。

const FAKE_API_SOURCE = [
  "const http = require('node:http');",
  'const port = Number(process.env.GY_FAKE_API_PORT);',
  'http',
  '  .createServer((req, res) => {',
  "    res.writeHead(200, {'content-type': 'application/json'});",
  "    res.end(JSON.stringify({status: 'ok', checks: {database: {status: 'ok'}}, meta: {execution_mode: 'real'}}));",
  '  })',
  "  .listen(port, '127.0.0.1');",
].join('\n');

/** 拿一个当前空闲的端口：绑 0 读回真实端口再关掉（窄窗口竞态，够用）。 */
function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const {port} = probe.address();
      probe.close(() => done(port));
    });
  });
}

function portOpen(port) {
  return new Promise((done) => {
    const socket = connect({port, host: '127.0.0.1'});
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
    socket.once('timeout', () => {
      socket.destroy();
      done(false);
    });
  });
}

async function waitForPort(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`假 API 没在 127.0.0.1:${port} 上起来`);
}

/** 起一个假 API；`approved` 决定它的命令行里有没有 `--approve-real-media-wiring`。 */
async function startFakeApi({port, instanceId, approved}) {
  const args = ['-e', FAKE_API_SOURCE, '--', `${INSTANCE_FLAG}${instanceId}`];
  if (approved) args.push('--approve-real-media-wiring');
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {...process.env, GY_FAKE_API_PORT: String(port)},
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForPort(port);
  return child;
}

function fakeAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

async function withAsyncTempStateDir(run) {
  const stateDir = mkdtempSync(join(tmpdir(), 'gy-demo-stack-cli-'));
  try {
    return await run(stateDir);
  } finally {
    rmSync(stateDir, {recursive: true, force: true});
  }
}

function writePidFile(stateDir, {pid, port, instanceId, demo, approvals}) {
  const record = buildPidRecord({
    pid,
    port,
    mode: 'real',
    instanceId,
    startedAt: new Date().toISOString(),
    logFile: join(stateDir, 'api.log'),
    demo,
    approvals,
  });
  writeFileSync(join(stateDir, 'api.pid'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

function runTool(args) {
  return spawnSync(process.execPath, [TOOL, ...args], {cwd: ROOT, encoding: 'utf8', timeout: 90_000});
}

test('up --demo 打到已带媒体批准的既有实例：复用，不重启', {skip: NEEDS_COMMAND_LINE}, async () => {
  const port = await freePort();
  const instanceId = 'inst-reuse-1';
  const child = await startFakeApi({port, instanceId, approved: true});
  try {
    await withAsyncTempStateDir(async (stateDir) => {
      writePidFile(stateDir, {pid: child.pid, port, instanceId, demo: true, approvals: {media: true, moderation: false}});

      const result = runTool([
        'up', '--demo', '--mode', 'real',
        '--port', String(port),
        '--pg-port', String(await freePort()),
        '--state-dir', stateDir,
        '--timeout-ms', '8000',
      ]);

      assert.equal(result.status, 0, `同样档位重复 up 应 exit 0，实际 ${result.status}\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /不重复启动/u, '已就绪且批准项齐备时应当复用');
      assert.doesNotMatch(result.stdout, /已重启 API/u, '同样档位重复 up 不该无谓重启');
      assert.equal(fakeAlive(child), true, '既有实例必须还活着');

      const after = JSON.parse(readFileSync(join(stateDir, 'api.pid'), 'utf8'));
      assert.equal(after.pid, child.pid, 'pid 没变 = 没重启');
    });
  } finally {
    child.kill();
  }
});

test('up --demo 打到缺媒体批准的既有实例：不静默通过，先说明要重启，且不动在跑的实例', {skip: NEEDS_COMMAND_LINE}, async () => {
  const port = await freePort();
  const instanceId = 'inst-missing-1';
  const child = await startFakeApi({port, instanceId, approved: false});
  try {
    await withAsyncTempStateDir(async (stateDir) => {
      // 旧实例是「up 起过、但没带 --demo」留下的：pid 记录如实写没批准。
      writePidFile(stateDir, {pid: child.pid, port, instanceId, demo: false, approvals: {media: false, moderation: false}});
      // 让收敛步骤必然走不到「重启」那一步：空的 bin 目录里没有 pg_ctl（env 缺项也会先挡住）。
      const emptyPgBin = join(stateDir, 'pg-bin-empty');
      mkdirSync(emptyPgBin, {recursive: true});

      const result = runTool([
        'up', '--demo', '--mode', 'real',
        '--port', String(port),
        '--pg-port', String(await freePort()),
        '--state-dir', stateDir,
        '--pg-bin', emptyPgBin,
        '--timeout-ms', '8000',
      ]);

      assert.notEqual(result.status, 0, `缺批准时绝不能 exit 0（那是「看起来开好了」的 B2 缺陷）\n${result.stdout}`);
      assert.match(result.stdout, /批准项不满足这次的要求/u, '要点名既有实例与这次要求不一致');
      assert.match(result.stdout, /缺 --approve-real-media-wiring/u, '要指名缺的是哪个批准项');
      assert.match(`${result.stdout}\n${result.stderr}`, /只能靠重启 API 生效/u, '要说清为什么再跑一次 up 没用');
      assert.match(result.stdout, /\[3\/9\]/u, '不能静默返回：要继续走收敛步骤（批准项得等重启才生效）');
      assert.match(`${result.stdout}\n${result.stderr}`, /env 文件不存在|缺 env|pg_ctl|PostgreSQL/u, '给出可执行的下一步，不是一句「失败」');
      assert.doesNotMatch(result.stdout, /已重启 API/u, '收敛步骤没过就不该真的去重启');
      assert.equal(fakeAlive(child), true, '收敛步骤没过之前不许先杀在跑的实例');
    });
  } finally {
    child.kill();
  }
});

test('status：进程行如实报「媒体批准=未带 / 已带」', async () => {
  const instanceId = 'inst-status-1';

  const portMissing = await freePort();
  const missing = await startFakeApi({port: portMissing, instanceId, approved: false});
  try {
    await withAsyncTempStateDir(async (stateDir) => {
      // pid 记录里写着媒体已批（旧版本写的/用户手改的），但进程命令行没有 ⇒ 必须以命令行为准。
      writePidFile(stateDir, {pid: missing.pid, port: portMissing, instanceId, demo: true, approvals: {media: true, moderation: false}});
      const result = runTool(['status', '--state-dir', stateDir, '--port', String(portMissing), '--pg-port', String(await freePort())]);
      assert.equal(result.status, 0, `status 应 exit 0，实际 ${result.status}\n${result.stderr}`);
      const lines = result.stdout.split(/\r?\n/u).filter((line) => line !== '');
      assert.ok(lines.length >= 3, '结论至少三行');
      assert.match(lines[0], /^进程：/u);
      assert.match(lines[0], /媒体批准=未带/u, `进程行必须如实报「未带」，实际 ${lines[0]}`);
      assert.doesNotMatch(lines[0], /媒体批准=已带/u);
    });
  } finally {
    missing.kill();
  }

  const portApproved = await freePort();
  const approved = await startFakeApi({port: portApproved, instanceId, approved: true});
  try {
    await withAsyncTempStateDir(async (stateDir) => {
      writePidFile(stateDir, {pid: approved.pid, port: portApproved, instanceId, demo: true, approvals: {media: false, moderation: false}});
      const result = runTool(['status', '--state-dir', stateDir, '--port', String(portApproved), '--pg-port', String(await freePort()), '--json']);
      assert.equal(result.status, 0, `status --json 应 exit 0，实际 ${result.status}\n${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.equal(report.api.approvals.media, true, '命令行带批准 ⇒ JSON 里 media 必须是 true（不信 pid 记录里的旧值）');
      assert.equal(report.api.approvalsSource, 'command-line');
    });
  } finally {
    approved.kill();
  }
});
