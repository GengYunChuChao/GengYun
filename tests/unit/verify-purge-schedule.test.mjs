/**
 * GY-R32 · #19 · `tools/verify-purge-schedule.mjs` 的单测 —— 正臂（真仓库）+ 负控制（临时目录改坏）。
 *
 * 为什么要负控制：本门禁的价值全在「改坏了会不会红」上。只跑真仓库的绿臂时，
 * 一个「永远是绿」的橡皮图章也能过 —— 所以每一条判据都要有一个**夹具**把它踩红，
 * 并且断言红的时候**点名了那个文件**（否则红也定位不到人）。
 *
 * 夹具做法（照 `tests/unit/verify-migrations-unique.test.mjs` 的分层）：
 *   · 在 `os.tmpdir()` 下铺一棵**最小仓库镜像**：`package.json`（三条 purge script，
 *     从真仓 `package.json` 原样取命令）、`tools/` 下三个入口空文件、`services/api/src/` 下
 *     一个不含 `setInterval(` 的桩文件、以及 `deploy/purge-schedule/` 下的**真单元文件副本**；
 *   · 先证明「一字不改 ⇒ 退出码 0」（对照组），再逐条改坏一处 ⇒ 退出码 1 且点名；
 *   · 断言的是**退出码**与**关键输出** —— 门禁在 CI 里被判的就是这两样。
 *
 * ⚠ 为什么这里**不**用 `spawnSync` 起子进程：本仓的开发机沙箱禁止程序打开命名管道
 * （`child_process.spawn` 默认 `stdio:'pipe'` ⇒ `EPERM`），而 `node --test` 自己也要 spawn。
 * 所以这里直接调**同一个 `main()`**（`node tools/verify-purge-schedule.mjs` 的执行体就是
 * `process.exitCode = main()`），只把 `console.log/error` 临时接到内存里取输出 ——
 * 判据面（arg 解析、退出码、报告文案）一模一样，且在沙箱与 CI 上都可跑。
 *
 * ⛔ 任何用例都不写 `deploy/` 与 `services/api/src/`（真仓库只在 §2 里**只读**跑一次）。
 * 夹具目录一律建在 `os.tmpdir()`，`after()` 里删掉。
 *
 * 分层：
 *   §1 CLI 用法与退出码约定（0 / 1 / 2）；
 *   §2 真仓库正臂（并核对三条 timer 的**实算**间隔与各自的上界档）；
 *   §3 夹具对照组（一字不改 ⇒ 绿）；
 *   §4 负控制（**13 个用例 / 17 条控制臂** —— 基线 10 / 14，本片 +3 用例 / +3 臂：
 *      retention timer 的 `Unit=` 换成分钟级命令（日级间隔立刻撞 60 分钟上界）/ 删掉 retention
 *      那一对单元 / 夹具 `package.json` 删掉 `purge:retention` script。基线臂：缺 OnCalendar /
 *      间隔 > 60 / `--cursor-file` 相对路径 / `--cursor-file` 用 `..` 穿越出状态目录 / 内联 DSN /
 *      非常见键名的内联口令键（`Environment=DB_PASS=…`）/ ExecStart 不存在 / 注入 `setInterval(` /
 *      `globalThis.setInterval(` / 带空白的 `setInterval (` / npm script 不存在 / 删掉整条备份单元 /
 *      `User=root` / 调度目录整块消失）；
 *   §5 纯函数：日历展开、时长解析、入口解析、游标参数、部署根后缀映射、间隔上界分档。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CRITERIA,
  CURSOR_REQUIRED_ENTRY,
  DAILY_INTERVAL_MINUTES,
  DEFAULT_SCHEDULE_DIR,
  INTERVAL_BUDGET_MINUTES,
  MAX_INTERVAL_MINUTES,
  REQUIRED_NPM_SCRIPTS,
  calendarFireSeconds,
  cursorArgs,
  execStartEntry,
  findSetIntervalCalls,
  intervalBudgetLabel,
  intervalBudgetMinutes,
  main,
  maxGapSeconds,
  npmScriptEntry,
  parseSystemdDurationSeconds,
  repoRelativeEntry,
  verifyPurgeSchedule,
} from '../../tools/verify-purge-schedule.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = join(REPO_ROOT, 'tools', 'verify-purge-schedule.mjs');
const UNIT_DIR = join(REPO_ROOT, 'deploy', 'purge-schedule');

/** 真仓里的单元文件（夹具直接复制它们，判据与真仓不脱钩）。 */
const REAL_UNITS = readdirSync(UNIT_DIR)
  .filter((name) => name.endsWith('.service') || name.endsWith('.timer'))
  .sort();

/** 本文件造过的临时目录，`after()` 统一清理。 */
const FIXTURES = [];

after(() => {
  for (const dir of FIXTURES) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该改变判据结论（临时目录由 OS 兜底回收）。
    }
  }
});

/**
 * 跑 CLI 入口 `main()`（与 `node tools/verify-purge-schedule.mjs` 同一条代码路径），
 * 只把 `console.log` / `console.error` 临时接到内存里取输出。
 * 理由见文件头「为什么这里不用 spawnSync」。
 */
function runCli(args) {
  const out = [];
  const err = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => { out.push(parts.join(' ')); };
  console.error = (...parts) => { err.push(parts.join(' ')); };
  try {
    const status = main(['node', TOOL, ...args]);
    return { status, stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/** 被点名的判据编号集合（`FAIL[<id>]`）。 */
function failureIds(stdout) {
  return [...new Set([...stdout.matchAll(/FAIL\[([a-z-]+)\]/g)].map((match) => match[1]))].sort();
}

/** 真实 `package.json` 里某条 script 的命令文本（夹具照抄，避免与真仓口径漂移）。 */
function realScript(name) {
  const scripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts;
  assert.equal(typeof scripts[name], 'string', `真仓 package.json 里必须有 ${name}（夹具前提）`);
  return scripts[name];
}

/**
 * 造一棵最小仓库镜像：`package.json` + 两个入口 + `services/api/src` 桩 + 真单元副本。
 * @returns {string} 夹具根目录
 */
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gy-r32-purge-sched-'));
  FIXTURES.push(dir);

  const scripts = {};
  for (const name of REQUIRED_NPM_SCRIPTS) scripts[name] = realScript(name);
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, scripts }, null, 2)}\n`,
    'utf8',
  );

  mkdirSync(join(dir, 'tools'), { recursive: true });
  for (const name of REQUIRED_NPM_SCRIPTS) {
    const entry = npmScriptEntry(scripts[name]);
    assert.notEqual(entry, null, `真仓 ${name} 必须能解析出入口文件（夹具前提）`);
    writeFileSync(join(dir, entry), '// fixture 入口（内容不参与判据，只要求「文件真实存在」）\n', 'utf8');
  }

  mkdirSync(join(dir, 'services', 'api', 'src', 'privacy'), { recursive: true });
  writeFileSync(
    join(dir, 'services', 'api', 'src', 'privacy', 'stub.ts'),
    '// fixture：扫描面必须非空，且这里不得出现进程内定时器调用\nexport const stub = 1;\n',
    'utf8',
  );

  mkdirSync(join(dir, DEFAULT_SCHEDULE_DIR), { recursive: true });
  for (const name of REAL_UNITS) {
    copyFileSync(join(UNIT_DIR, name), join(dir, DEFAULT_SCHEDULE_DIR, name));
  }
  return dir;
}

/** 在夹具里就地改一个文件（读 → 替换 → 写回）。 */
function mutate(dir, relativePath, transform) {
  const path = join(dir, relativePath);
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  assert.notEqual(after, before, `负控制必须真的改动了 ${relativePath}（否则这条反例没有证明力）`);
  writeFileSync(path, after, 'utf8');
}

/** 在线清理单元在夹具里的相对路径（判据面全名，供负控制定位）。 */
const ONLINE_SERVICE = `${DEFAULT_SCHEDULE_DIR}/gengyun-purge-online-data.service`;
const ONLINE_TIMER = `${DEFAULT_SCHEDULE_DIR}/gengyun-purge-online-data.timer`;
const BACKUP_SERVICE = `${DEFAULT_SCHEDULE_DIR}/gengyun-purge-backup-copies.service`;
const BACKUP_TIMER = `${DEFAULT_SCHEDULE_DIR}/gengyun-purge-backup-copies.timer`;
const RETENTION_SERVICE = `${DEFAULT_SCHEDULE_DIR}/gengyun-purge-retention.service`;
const RETENTION_TIMER = `${DEFAULT_SCHEDULE_DIR}/gengyun-purge-retention.timer`;

// ---------------------------------------------------------------------------
// §1 CLI 用法与退出码约定
// ---------------------------------------------------------------------------

test('用法·--help 打印用法并以 0 退出（「帮我看一眼」不是失败）', () => {
  const { status, stdout } = runCli(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /用法/);
  assert.match(stdout, /--root/);
  assert.match(stdout, /0 = 全部满足/);
  assert.match(stdout, new RegExp(`≤ ${MAX_INTERVAL_MINUTES} 分钟`));
  // 上界是**分档**的：分钟级那一档仍是 60，日级那一档是 1440（用法里必须两档都说得出来）。
  assert.match(stdout, new RegExp(`≤ ${DAILY_INTERVAL_MINUTES} 分钟`));
  assert.match(stdout, /日级命令（purge:retention）/);
  assert.match(stdout, /未登记\/未解析到入口一律按/);
});

test('用法·未知参数 ⇒ 退出码 2（用法错误 ≠ 判据不满足）', () => {
  const { status, stderr } = runCli(['--schedule-dir', 'x']);
  assert.equal(status, 2);
  assert.match(stderr, /未知参数：--schedule-dir/);
  assert.match(stderr, /退出码/);
});

test('用法·--root 缺参数 ⇒ 退出码 2', () => {
  const { status, stderr } = runCli(['--root']);
  assert.equal(status, 2);
  assert.match(stderr, /--root 需要一个目录参数/);
});

test('用法·--json 的 stdout 必须是纯 JSON，且带稳定契约字段', () => {
  const { status, stdout } = runCli(['--json']);
  assert.equal(status, 0, `真仓库的 --json 应 exit 0：\n${stdout}`);
  const report = JSON.parse(stdout);
  assert.equal(report.tool, 'verify-purge-schedule');
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.criteria, [...CRITERIA]);
  assert.deepEqual(report.requiredNpmScripts, [...REQUIRED_NPM_SCRIPTS]);
  assert.equal(report.cursorRequiredEntry, CURSOR_REQUIRED_ENTRY);
  assert.equal(report.maxIntervalMinutes, MAX_INTERVAL_MINUTES);
  assert.equal(report.dailyIntervalMinutes, DAILY_INTERVAL_MINUTES);
  assert.deepEqual(report.intervalBudgets, { ...INTERVAL_BUDGET_MINUTES });
  assert.equal(report.counts.services, 3);
  assert.equal(report.counts.timers, 3);
  assert.equal(report.counts.setIntervalHits, 0);
  assert.deepEqual(report.failures, []);
});

// ---------------------------------------------------------------------------
// §2 真仓库正臂
// ---------------------------------------------------------------------------

test('正臂·真仓库：10 项判据全部满足，exit 0', () => {
  const { status, stdout } = runCli([]);
  assert.equal(status, 0, `真仓库必须绿（这是本片交付的调度产物本身）：\n${stdout}`);
  assert.match(stdout, new RegExp(`PASS：${CRITERIA.length} 项判据全部满足`));
  assert.match(stdout, /\.service 3 个 \/ \.timer 3 个逐条有交代/);
  // 判据不是「有 OnCalendar 就放行」：三条 timer 的**实算**间隔必须真的 ≤ 各自命令的上界。
  assert.match(stdout, /最大间隔 10 分钟/);
  assert.match(stdout, /最大间隔 15 分钟/);
  // 日级那一档：只有驱动 `tools/purge-retention-expired.mjs` 的 timer 才按 1440 分钟判。
  assert.match(stdout, /每天 1 次触发，最大间隔 1440 分钟（上界 1440 分钟 · 日级命令 tools\/purge-retention-expired\.mjs/);
  assert.match(stdout, /（上界 60 分钟 · 分钟级命令 tools\/purge-expired-online-data\.mjs）/);
  assert.match(stdout, /（上界 60 分钟 · 分钟级命令 tools\/purge-expired-backup-copies\.mjs）/);
  assert.match(stdout, /`setInterval\(` 命中 0 处/);
  assert.equal(failureIds(stdout).length, 0);
});

test('正臂·代码内联调用（不经 CLI）：真仓库 ok=true，且三条必须命令都被覆盖', () => {
  const result = verifyPurgeSchedule({});
  assert.equal(result.ok, true, `verifyPurgeSchedule 在真仓库上应 ok=true：${JSON.stringify(result.failures)}`);
  assert.equal(result.counts.services, 3);
  assert.equal(result.counts.timers, 3);
  assert.equal(result.counts.setIntervalHits, 0);
  assert.ok(result.counts.setIntervalFiles > 100, `扫描面应覆盖 services/api/src 的代码文件，实际 ${result.counts.setIntervalFiles}`);
  assert.equal(result.counts.coveredNpmScripts, REQUIRED_NPM_SCRIPTS.length);
  assert.deepEqual(result.failures, []);
});

test('真岗·单元文件必须是 LF（.NET/PS 默认 CRLF 会让另一条 CI 判据红）', () => {
  for (const name of REAL_UNITS) {
    const text = readFileSync(join(UNIT_DIR, name), 'utf8');
    assert.equal(text.includes('\r'), false, `${name} 含 CR：本仓 CI 按行尾判红（显式 LF 是硬要求）`);
  }
});

test('正臂·cron 路线已按 R32 返修裁定删除（目录只剩 .service/.timer，README 说明原因）', () => {
  const names = readdirSync(UNIT_DIR).sort();
  // ① 目录里不得再有任何 cron 路线文件（删除后又被「顺手」加回来 ⇒ 红）。
  assert.deepEqual(names.filter((name) => /cron/i.test(name)), [],
    `deploy/purge-schedule 下不得再有 cron 路线文件：${names.join('、')}`);
  // ② 判据面就是 .service / .timer，目录里只允许这两类 + README（多出别的调度件要显式改判据）。
  assert.deepEqual(names.filter((name) => !/\.(service|timer)$/.test(name) && name !== 'README.md'), [],
    `本目录只允许 .service / .timer / README.md：${names.join('、')}`);
  const readme = readFileSync(join(UNIT_DIR, 'README.md'), 'utf8');
  // ③ 理由必须留在文档里（删掉一节说明 = 把「为什么没有 cron」重新变成无人知道的空白）。
  assert.ok(readme.includes('## 为什么不再提供 cron 等价路线'), 'README 必须有「为什么不再提供 cron 等价路线」一节');
  assert.ok(readme.includes('唯一受支持路线'), 'README 必须写明 systemd timer 是唯一受支持路线');
  assert.ok(readme.includes('set -a'), 'README 必须写明第 2 轮的 `set -a` 变量导出缺陷');
  assert.ok(readme.includes('`/run`'), 'README 必须写明第 1 轮的 `/run` 锁文件缺陷');
  // ④ 不得留下任何可照抄的安装命令或「逐项对应」式承诺（那正是被砍掉的埋雷形态）。
  assert.equal(readme.includes('crontab.example /etc/cron.d/gengyun-purge'), false,
    'README 不得再给出安装 cron 文件的命令');
  assert.equal(readme.includes('/etc/cron.d/gengyun-purge'), false,
    'README 不得再出现 /etc/cron.d/gengyun-purge 这个安装目标');
  assert.equal(/逐项等价/.test(readme), false, 'README 不得再写「逐项等价」这类措辞');
  assert.equal(/逐项对应/.test(readme), false, 'README 不得再写「逐项对应」这类措辞');
});

// ---------------------------------------------------------------------------
// §3 夹具对照组：一字不改 ⇒ 绿（否则 §4 的红证明不了任何事）
// ---------------------------------------------------------------------------

test('夹具对照·单位全绿（证明后续负控制的红来自「被改坏的那一条」）', () => {
  const dir = makeFixture();
  const { status, stdout } = runCli(['--root', dir]);
  assert.equal(status, 0, `对照组必须绿，否则负控制失去证明力：\n${stdout}`);
  assert.match(stdout, /PASS：/);
});

// ---------------------------------------------------------------------------
// §4 负控制：每条都要求 exit 1 + 点名判据 + 点名文件
// ---------------------------------------------------------------------------

test('负控制①：timer 缺 OnCalendar（也没有 OnUnitActiveSec）⇒ FAIL[calendar] 点名 timer', () => {
  const dir = makeFixture();
  mutate(dir, ONLINE_TIMER, (text) => text.split('\n').filter((line) => !line.startsWith('OnCalendar=')).join('\n'));
  const { status, stdout } = runCli(['--root', dir]);
  assert.equal(status, 1, stdout);
  assert.ok(failureIds(stdout).includes('calendar'), `应点名 calendar，实际：${failureIds(stdout)}\n${stdout}`);
  assert.match(stdout, /gengyun-purge-online-data\.timer/);
  assert.match(stdout, /缺少 `OnCalendar=` 或 `OnUnitActiveSec=`/);
});

test('负控制②：OnCalendar 每天一次（间隔 > 60 分钟）⇒ FAIL[calendar] 点名「最大间隔 1440 分钟」', () => {
  const dir = makeFixture();
  mutate(dir, ONLINE_TIMER, (text) => text.replace('*-*-* *:00/10:00', '*-*-* 02:00:00'));
  const { status, stdout } = runCli(['--root', dir]);
  assert.equal(status, 1, stdout);
  assert.ok(failureIds(stdout).includes('calendar'), `应点名 calendar，实际：${failureIds(stdout)}\n${stdout}`);
  assert.match(stdout, /最大间隔 1440 分钟 > 60 分钟/);
});

test('负控制③：--cursor-file 相对路径 / `..` 穿越 ⇒ FAIL[cursor] 点名 service（控制臂 2）', () => {
  // 臂 1：相对路径（缺省游标会随 cwd 漂移）。
  const relativeDir = makeFixture();
  mutate(relativeDir, ONLINE_SERVICE, (text) => text.replace(
    /--cursor-file=\/var\/lib\/[^\s]+/,
    '--cursor-file=./online-purge-cursor.json',
  ));
  const relativeRun = runCli(['--root', relativeDir]);
  assert.equal(relativeRun.status, 1, relativeRun.stdout);
  assert.ok(failureIds(relativeRun.stdout).includes('cursor'),
    `应点名 cursor，实际：${failureIds(relativeRun.stdout)}\n${relativeRun.stdout}`);
  assert.match(relativeRun.stdout, /gengyun-purge-online-data\.service/);
  assert.match(relativeRun.stdout, /不是绝对路径/);

  // 臂 2：绝对路径但用 `..` 逃出 StateDirectory（字符串前缀比对会放过，归一化后才判红）。
  const traversalDir = makeFixture();
  mutate(traversalDir, ONLINE_SERVICE, (text) => text.replace(
    /--cursor-file=\/var\/lib\/[^\s]+/,
    '--cursor-file=/var/lib/gengyun-purge-online-data/../../etc/passwd',
  ));
  const traversalRun = runCli(['--root', traversalDir]);
  assert.equal(traversalRun.status, 1, traversalRun.stdout);
  assert.ok(failureIds(traversalRun.stdout).includes('cursor'),
    `穿越写法必须点名 cursor，实际：${failureIds(traversalRun.stdout)}\n${traversalRun.stdout}`);
  assert.match(traversalRun.stdout, /归一化后不在/);
  assert.match(traversalRun.stdout, /· 归一化：\/var\/etc\/passwd/);
});

test('负控制④：内联 DSN / 非常见键名口令 ⇒ FAIL[secrets] 点名 service（控制臂 2）', () => {
  // 臂 1：常见键名 + 连接串（基线已有的形状）。
  const dsnDir = makeFixture();
  mutate(dsnDir, ONLINE_SERVICE, (text) => `${text}\nEnvironment=DATABASE_URL=postgres://ci:synthetic@127.0.0.1:5432/gengyun\n`);
  const dsnRun = runCli(['--root', dsnDir]);
  assert.equal(dsnRun.status, 1, dsnRun.stdout);
  assert.ok(failureIds(dsnRun.stdout).includes('secrets'),
    `应点名 secrets，实际：${failureIds(dsnRun.stdout)}\n${dsnRun.stdout}`);
  assert.match(dsnRun.stdout, /gengyun-purge-online-data\.service/);

  // 臂 2：**非** DATABASE_URL 命名的内联口令（`Environment=DB_PASS=…`）。
  const passDir = makeFixture();
  // 值里刻意**不含**口令类词根：这样命中只能来自键名 `DB_PASS`（否则「值里恰好有个 secret」也能让断言变绿）。
  mutate(passDir, ONLINE_SERVICE, (text) => `${text}\nEnvironment=DB_PASS=synthetic-for-test\n`);
  const passRun = runCli(['--root', passDir]);
  assert.equal(passRun.status, 1, passRun.stdout);
  assert.ok(failureIds(passRun.stdout).includes('secrets'),
    `非常见键名也必须点名 secrets，实际：${failureIds(passRun.stdout)}\n${passRun.stdout}`);
  assert.match(passRun.stdout, /DB_PASS/);
  assert.match(passRun.stdout, /内联凭据键/);
});

test('负控制⑤：ExecStart 指向不存在的脚本 ⇒ FAIL[execstart] 点名 service', () => {
  const dir = makeFixture();
  mutate(dir, ONLINE_SERVICE, (text) => text.replace(
    '/tools/purge-expired-online-data.mjs',
    '/tools/purge-expired-online-data-v2.mjs',
  ));
  const { status, stdout } = runCli(['--root', dir]);
  assert.equal(status, 1, stdout);
  assert.ok(failureIds(stdout).includes('execstart'), `应点名 execstart，实际：${failureIds(stdout)}\n${stdout}`);
  assert.match(stdout, /本树上不存在/);
  assert.match(stdout, /purge-expired-online-data-v2\.mjs/);
});

test('负控制⑥：注入 setInterval( / globalThis.setInterval( / setInterval ( ⇒ FAIL[setinterval] 点名文件（控制臂 3）', () => {
  // 臂 1：基线形状。
  const plainDir = makeFixture();
  writeFileSync(
    join(plainDir, 'services', 'api', 'src', 'privacy', 'injected-timer.ts'),
    'export function boot(): void {\n  setInterval(() => {}, 1000);\n}\n',
    'utf8',
  );
  const plainRun = runCli(['--root', plainDir]);
  assert.equal(plainRun.status, 1, plainRun.stdout);
  assert.ok(failureIds(plainRun.stdout).includes('setinterval'),
    `应点名 setinterval，实际：${failureIds(plainRun.stdout)}\n${plainRun.stdout}`);
  assert.match(plainRun.stdout, /services\/api\/src\/privacy\/injected-timer\.ts/);
  assert.match(plainRun.stdout, /第 2 行出现 `setInterval\(`/);

  // 臂 2：`globalThis.` 前缀（字面子串 `setInterval(` 仍能命中，但口径必须明说它算命中）。
  const globalDir = makeFixture();
  writeFileSync(
    join(globalDir, 'services', 'api', 'src', 'privacy', 'global-timer.ts'),
    'export function boot(): void {\n  globalThis.setInterval(() => {}, 1000);\n}\n',
    'utf8',
  );
  const globalRun = runCli(['--root', globalDir]);
  assert.equal(globalRun.status, 1, globalRun.stdout);
  assert.ok(failureIds(globalRun.stdout).includes('setinterval'),
    `globalThis.setInterval 必须点名 setinterval，实际：${failureIds(globalRun.stdout)}\n${globalRun.stdout}`);
  assert.match(globalRun.stdout, /services\/api\/src\/privacy\/global-timer\.ts/);
  assert.match(globalRun.stdout, /globalThis\.setInterval\(/);

  // 臂 3：标识符与 `(` 之间带空白（`setInterval (`）。
  const spacedDir = makeFixture();
  writeFileSync(
    join(spacedDir, 'services', 'api', 'src', 'privacy', 'spaced-timer.ts'),
    'export function boot(): void {\n  setInterval (() => {}, 1000);\n}\n',
    'utf8',
  );
  const spacedRun = runCli(['--root', spacedDir]);
  assert.equal(spacedRun.status, 1, spacedRun.stdout);
  assert.ok(failureIds(spacedRun.stdout).includes('setinterval'),
    `带空白的 setInterval ( 必须点名 setinterval，实际：${failureIds(spacedRun.stdout)}\n${spacedRun.stdout}`);
  assert.match(spacedRun.stdout, /services\/api\/src\/privacy\/spaced-timer\.ts/);
  assert.match(spacedRun.stdout, /setInterval \(/);
});

test('负控制⑦：unit 引用的 npm script 不存在 ⇒ FAIL[npm-script] 点名 service', () => {
  const dir = makeFixture();
  mutate(dir, ONLINE_SERVICE, (text) => text.replace('npm-script=purge:online-data', 'npm-script=purge:online-data-v2'));
  const { status, stdout } = runCli(['--root', dir]);
  assert.equal(status, 1, stdout);
  assert.ok(failureIds(stdout).includes('npm-script'), `应点名 npm-script，实际：${failureIds(stdout)}\n${stdout}`);
  assert.match(stdout, /purge:online-data-v2/);
  assert.match(stdout, /不在 package\.json 的 scripts 里/);
});

test('负控制⑧：删掉整条备份单元（形态仍合法）⇒ FAIL[coverage] 点名未覆盖的 script', () => {
  const dir = makeFixture();
  rmSync(join(dir, BACKUP_SERVICE));
  rmSync(join(dir, BACKUP_TIMER));
  const { status, stdout } = runCli(['--root', dir]);
  assert.equal(status, 1, stdout);
  assert.ok(failureIds(stdout).includes('coverage'), `应点名 coverage，实际：${failureIds(stdout)}\n${stdout}`);
  assert.match(stdout, /purge:backup-copies` 没有被任何/);
});

test('负控制⑨：User=root ⇒ FAIL[hygiene]（权限面不因「跑得通」放过）', () => {
  const dir = makeFixture();
  mutate(dir, ONLINE_SERVICE, (text) => text.replace(/^User=.*$/m, 'User=root'));
  const { status, stdout } = runCli(['--root', dir]);
  assert.equal(status, 1, stdout);
  assert.ok(failureIds(stdout).includes('hygiene'), `应点名 hygiene，实际：${failureIds(stdout)}\n${stdout}`);
  assert.match(stdout, /不允许以 root 运行/);
});

test('负控制⑩：调度目录整块消失 ⇒ FAIL[surface]（扫到 0 个单元不是「全绿」）', () => {
  const dir = makeFixture();
  rmSync(join(dir, DEFAULT_SCHEDULE_DIR), { recursive: true, force: true });
  const { status, stdout } = runCli(['--root', dir]);
  assert.equal(status, 1, stdout);
  assert.ok(failureIds(stdout).includes('surface'), `应点名 surface，实际：${failureIds(stdout)}\n${stdout}`);
  assert.match(stdout, /找不到调度目录/);
});

test('负控制⑪：日级 timer 换成分钟级命令 ⇒ FAIL[calendar] 把 1440 分钟撞回 60 分钟上界', () => {
  // 上界**跟着命令走**，不是跟着单元名/文件名走：同一行 `OnCalendar=*-*-* 03:20:00`
  // 驱动日级命令（`purge:retention`）是绿的，驱动分钟级命令就必须红。
  const dir = makeFixture();
  mutate(dir, RETENTION_TIMER, (text) => text.replace(
    'Unit=gengyun-purge-retention.service',
    'Unit=gengyun-purge-online-data.service',
  ));
  const { status, stdout } = runCli(['--root', dir]);
  assert.equal(status, 1, stdout);
  assert.ok(failureIds(stdout).includes('calendar'), `应点名 calendar，实际：${failureIds(stdout)}\n${stdout}`);
  assert.match(stdout, /最大间隔 1440 分钟 > 60 分钟/);
  assert.match(stdout, /分钟级命令 tools\/purge-expired-online-data\.mjs/);
});

test('负控制⑫：删掉 retention 那一对单元 ⇒ FAIL[coverage] 点名 purge:retention 没被驱动', () => {
  const dir = makeFixture();
  rmSync(join(dir, RETENTION_SERVICE));
  rmSync(join(dir, RETENTION_TIMER));
  const { status, stdout } = runCli(['--root', dir]);
  assert.equal(status, 1, stdout);
  assert.ok(failureIds(stdout).includes('coverage'), `应点名 coverage，实际：${failureIds(stdout)}\n${stdout}`);
  assert.match(stdout, /purge:retention` 没有被任何/);
});

test('负控制⑬：package.json 少 purge:retention ⇒ FAIL[npm-script] 点名 service（必需清单是双向的）', () => {
  const dir = makeFixture();
  const packagePath = join(dir, 'package.json');
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  delete manifest.scripts['purge:retention'];
  writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const { status, stdout } = runCli(['--root', dir]);
  assert.equal(status, 1, stdout);
  assert.ok(failureIds(stdout).includes('npm-script'), `应点名 npm-script，实际：${failureIds(stdout)}\n${stdout}`);
  assert.match(stdout, /gengyun-purge-retention\.service/);
  assert.match(stdout, /purge:retention/);
  assert.match(stdout, /不在 package\.json 的 scripts 里/);
});

// ---------------------------------------------------------------------------
// §5 纯函数（日历展开是「间隔 ≤ 各自上界」这条判据的心脏，单独钉住）
// ---------------------------------------------------------------------------

test('日历展开·*:00/10:00 ⇒ 每天 144 次、最大间隔 10 分钟（与真仓单元同值）', () => {
  const offsets = calendarFireSeconds('*-*-* *:00/10:00');
  assert.equal(offsets.length, 144);
  assert.equal(maxGapSeconds(offsets), 600);
});

test('日历展开·*:05/15:00 ⇒ 每天 96 次、最大间隔 15 分钟（跨日那一跳也是 15）', () => {
  const offsets = calendarFireSeconds('*-*-* *:05/15:00');
  assert.equal(offsets.length, 96);
  assert.equal(maxGapSeconds(offsets), 900);
});

test('日历展开·每天一次 ⇒ 1440 分钟；看不懂的形态一律返回 null（⛔ 不猜）', () => {
  assert.equal(maxGapSeconds(calendarFireSeconds('*-*-* 02:00:00')), 24 * 60 * 60);
  assert.equal(calendarFireSeconds('hourly'), null);
  assert.equal(calendarFireSeconds('Mon..Fri *-*-* 02:00:00'), null);
  assert.equal(calendarFireSeconds('*-*-* 25:00:00'), null);
  assert.equal(calendarFireSeconds(''), null);
});

test('日历展开·秒级抖动不影响分钟级间隔判断（*:*:00 ⇒ 1 分钟）', () => {
  const offsets = calendarFireSeconds('*-*-* *:*:00');
  assert.equal(offsets.length, 24 * 60);
  assert.equal(maxGapSeconds(offsets), 60);
});

test('时长解析·OnUnitActiveSec / TimeoutStartSec 共用的口径', () => {
  assert.equal(parseSystemdDurationSeconds('900'), 900);
  assert.equal(parseSystemdDurationSeconds('10min'), 600);
  assert.equal(parseSystemdDurationSeconds('15m'), 900);
  assert.equal(parseSystemdDurationSeconds('1h30m'), 5400);
  assert.equal(parseSystemdDurationSeconds('30s'), 30);
  assert.equal(parseSystemdDurationSeconds('abc'), null);
  assert.equal(parseSystemdDurationSeconds('10min junk'), null);
  assert.equal(parseSystemdDurationSeconds(''), null);
});

test('入口解析·npm script 与 ExecStart 必须落到同一个仓库相对路径', () => {
  assert.equal(npmScriptEntry('node tools/purge-expired-online-data.mjs'), 'tools/purge-expired-online-data.mjs');
  assert.equal(npmScriptEntry('node "tools/x.mjs" --flag'), 'tools/x.mjs');
  assert.equal(npmScriptEntry('echo hi'), null);
  assert.equal(
    execStartEntry('/usr/bin/node /opt/gengyun/app/tools/purge-expired-online-data.mjs --cursor-file=/var/lib/x/y.json'),
    '/opt/gengyun/app/tools/purge-expired-online-data.mjs',
  );
  // `--cursor-file` 的值以 .json 结尾 ⇒ 不会被误当成入口文件。
  assert.equal(execStartEntry('/usr/bin/node --cursor-file=/var/lib/x/online-purge-cursor.json'), null);
});

test('游标参数·两种写法 + --no-cursor，并区分「有没有给」', () => {
  assert.deepEqual(cursorArgs('node a.mjs --cursor-file=/var/lib/x/y.json'), {
    files: ['/var/lib/x/y.json'],
    noCursor: false,
  });
  assert.deepEqual(cursorArgs('node a.mjs --cursor-file /var/lib/x/y.json'), {
    files: ['/var/lib/x/y.json'],
    noCursor: false,
  });
  assert.deepEqual(cursorArgs('node a.mjs --no-cursor'), { files: [], noCursor: true });
  assert.deepEqual(cursorArgs('node a.mjs'), { files: [], noCursor: false });
});

test('间隔上界分档·分钟级 60 / 日级 1440 / 未登记回落 60（⛔ 不是「想多稀都行」）', () => {
  assert.equal(MAX_INTERVAL_MINUTES, 60);
  assert.equal(DAILY_INTERVAL_MINUTES, 24 * 60);
  assert.equal(intervalBudgetMinutes('tools/purge-expired-online-data.mjs'), 60);
  assert.equal(intervalBudgetMinutes('tools/purge-expired-backup-copies.mjs'), 60);
  assert.equal(intervalBudgetMinutes('tools/purge-retention-expired.mjs'), 1440);
  // 归一化：反斜杠与 `./` 前缀落到同一档（否则 Windows 上造夹具会被「格式不对」放过）。
  assert.equal(intervalBudgetMinutes('tools\\purge-retention-expired.mjs'), 1440);
  assert.equal(intervalBudgetMinutes('./tools/purge-retention-expired.mjs'), 1440);
  // 未登记 / 未解析 ⇒ 回落分钟级：新增命令忘了登记时，红面比绿面安全。
  assert.equal(intervalBudgetMinutes('tools/nope.mjs'), 60);
  assert.equal(intervalBudgetMinutes(null), 60);
  assert.equal(intervalBudgetMinutes(''), 60);
  assert.deepEqual({ ...INTERVAL_BUDGET_MINUTES }, {
    'tools/purge-expired-online-data.mjs': MAX_INTERVAL_MINUTES,
    'tools/purge-expired-backup-copies.mjs': MAX_INTERVAL_MINUTES,
    'tools/purge-retention-expired.mjs': DAILY_INTERVAL_MINUTES,
  });
  // 上界出处文案：日级 / 分钟级必须能分清（红的时候要让人看出按哪一档判的）。
  assert.match(intervalBudgetLabel('tools/purge-retention-expired.mjs'), /日级命令 tools\/purge-retention-expired\.mjs（每天至少一次）/);
  assert.match(intervalBudgetLabel('tools/purge-expired-online-data.mjs'), /分钟级命令 tools\/purge-expired-online-data\.mjs/);
  assert.match(intervalBudgetLabel('tools/nope.mjs'), /入口未登记 tools\/nope\.mjs，回落分钟级/);
  assert.match(intervalBudgetLabel(null), /入口未登记 \(未解析\)，回落分钟级/);
  // 边界：日级上界正好等于「每天一次」的实算间隔 ⇒ 等于即通过，比它更稀在语法上写不出来。
  assert.equal(maxGapSeconds(calendarFireSeconds('*-*-* 03:20:00')) / 60, DAILY_INTERVAL_MINUTES);
});

test('部署根映射·按最长真实后缀回到仓库相对路径（与 /opt/gengyun/app 无关）', () => {
  assert.equal(
    repoRelativeEntry(REPO_ROOT, '/opt/gengyun/app/tools/purge-expired-online-data.mjs'),
    'tools/purge-expired-online-data.mjs',
  );
  assert.equal(repoRelativeEntry(REPO_ROOT, '/opt/gengyun/app/tools/nope.mjs'), null);
});

test('setInterval 扫描面·真仓 0 命中（这是「无进程内调度器」的机器化判据）', () => {
  const scan = findSetIntervalCalls(REPO_ROOT);
  assert.equal(scan.hits.length, 0, `services/api/src 里不得出现 setInterval(：${JSON.stringify(scan.hits)}`);
  assert.ok(scan.files > 100, `扫描面应覆盖全部代码文件，实际 ${scan.files}`);
});
