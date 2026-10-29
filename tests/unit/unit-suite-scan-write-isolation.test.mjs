/**
 * 跨文件竞态守卫（GY-R68）：**单测并行跑时，谁都不许往别人正在扫描的源码树里写文件。**
 *
 * ## 缺口（本片实测，基线 `91c800f6`）
 *
 * `tests/unit/sql-column-coverage.test.mjs` 的 NC7 负控制要证明「`services/api/src` 下多一个
 * 未登记的 SQL 宿主 ⇒ 文件集不变量的红字必须点名它」。旧版的做法是**往真实源码树里写**一个
 * `services/api/src/nc7-temp-sql-host.ts`，跑两次全树扫描（≈1.2s）后 `rmSync` 删掉。
 *
 * 同一时刻，`tests/unit/s4-data-gap-pins.test.mjs` 的 `walkFiles('services/api/src')` 正在
 * **先枚举、再逐文件读**（`scanTree` / `readRepoText`）。node 的 test runner 默认**按文件并行**，
 * 于是 s4 可能在这个 1.2s 窗口里枚举到那个临时文件，等它读到这一条时文件已经被删 ⇒ `existsSync`
 * 为假 ⇒ 报
 *
 *     判据位置不存在：services/api/src/nc7-temp-sql-host.ts
 *
 * （`s4-data-gap-pins.test.mjs` 的 `readRepoText`）。全量单测因此偶发假红：CI 假红、别人的 PR
 * 被判「需修改」，而两个文件单独跑都全绿。
 *
 * 复现命令（旧树偶发红；本仓 `node --test` 不需要 `node_modules`）：
 *
 *     node --test tests/unit/sql-column-coverage.test.mjs tests/unit/s4-data-gap-pins.test.mjs
 *
 * 全量更容易撞上（并行度 = CPU 核数，两个文件的扫描窗口更容易重叠）：
 *
 *     node --test "tests/unit/*.test.mjs"
 *
 * ## 本守卫固化的是什么
 *
 * 它把「两个文件同时跑」这件事变成一条**真并行**的用例：用 `node --test` 起**真子进程**跑那两个
 * 真文件，同时父进程每 25ms 轮询 s4 的各个扫描面（`SCAN_ROOTS`）的递归文件清单；**运行期间只要
 * 出现任何新文件就红**，并在红字里点名是哪个路径。
 *
 * 判据不靠时序运气：NC7 的临时宿主在旧树上存活 ≈1.2s，25ms 的采样密度不可能漏掉；而且下面第一条
 * 正控制会用**同一个采样器**对自己造一个「创建 → 240ms 后删掉」的探针，证明它真看得见这种
 * 「创建后又消失」的文件（否则 `created` 恒空的守卫等于没有）。
 *
 * 修法（NC7 里的注释有细节）：临时宿主写进 `os.tmpdir()` 的 `mkdtempSync` 沙箱，`discoverSqlHosts`
 * / `listTypeScriptFiles` **显式接收扫描基准**。断言强度不变 —— 扫的仍是磁盘上的真文件，「多一个
 * 未登记宿主 ⇒ 恰红 1 条并点名该文件」仍是同一条命题；变的只是树根。
 *
 * ⛔ 不要为了让这条变绿去：删 `SCAN_ROOTS`、把轮询间隔调大、把断言换成 `>=`、或给某个文件开白名单。
 * 真需要往这些树里写临时文件时，正确做法是**复制到 `os.tmpdir()` 沙箱并给被测函数显式传根目录**
 * （本仓既有 idiom，见 `tests/unit/test-line-anchors-guard.test.mjs` 的 `tempRoot`）。
 *
 * 单跑：`node --test tests/unit/unit-suite-scan-write-isolation.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` 的上两级），⛔ 不用 `process.cwd()`。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 被并行扫描的树 = `s4-data-gap-pins.test.mjs` 里 `walkFiles(...)` 的全部入参
 * （`services/api/src`、`packages`、`tools` 见它的 `ROOTS`，`tests/privacy` 见「缺口 2」的第三条，
 * `.github/workflows` 见「已接线 5」）。
 * 谁往这些树里写东西，谁就可能撞上别人的「枚举 → 读」。
 */
const SCAN_ROOTS = Object.freeze([
  'services/api/src',
  'packages',
  'tools',
  'tests/privacy',
  '.github/workflows',
]);

/** 与 s4 的 `walkFiles` 保持同一套跳过规则：这些目录里的东西不在判据面上。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.pg17']);

/** 要并行跑的两个真文件：加害者（写临时宿主）+ 受害者（逐文件读扫描面）。 */
const PAIR = Object.freeze([
  'tests/unit/sql-column-coverage.test.mjs',
  'tests/unit/s4-data-gap-pins.test.mjs',
]);

/** 采样间隔：必须远小于临时宿主的存活时间（旧树上 ≈1.2s）。 */
const POLL_MS = 25;

/** 子进程兜底超时（两个文件 ≈15s；卡住时别把整个 job 拖死）。 */
const CHILD_TIMEOUT_MS = 300_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Windows 分隔符归一化成 `/`，让报出来的路径与仓库口径一致。 */
const toPosix = (p) => p.split(sep).join('/');

/**
 * 递归列出 `absRoot` 下的**全部文件**（相对 `absRoot` 的 posix 路径，已排序）。
 * 跳过规则与 s4 的 `walkFiles` 对齐：软链不跟、`SKIP_DIRS`、`.` 开头的目录不进去。
 * @param {string} absRoot @returns {string[]}
 */
function listTree(absRoot) {
  /** @type {string[]} */
  const out = [];
  const visit = (dirAbs, prefix) => {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        visit(join(dirAbs, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  visit(absRoot, '');
  return out.sort();
}

/**
 * 在 `run()` 期间持续采样：返回运行期间**新出现**的文件（相对仓库根／相对沙箱根）。
 *
 * 只看「基线里没有、之后出现」的文件 —— 删掉的文件不算（本竞态的加害动作是「写」，删除只是
 * 收尾；真正的判据是「不许往别人的扫描面里放文件」）。跑完后再补一次全量扫描，避免最后一次
 * 轮询与进程退出之间的缝。
 *
 * @param {{label: string, abs: string}[]} roots `label` 用于拼报错路径（可为 ''）
 * @param {() => Promise<any>} run 被测动作
 * @returns {Promise<{created: string[], result: any}>}
 */
async function pollForNewFiles(roots, run) {
  const baseline = new Map(roots.map((root) => [root.abs, new Set(listTree(root.abs))]));
  /** @type {Set<string>} */
  const created = new Set();
  const sweep = () => {
    for (const root of roots) {
      const before = baseline.get(root.abs);
      for (const rel of listTree(root.abs)) {
        if (before.has(rel)) continue;
        created.add(root.label === '' ? rel : `${root.label}/${rel}`);
      }
    }
  };
  let stop = false;
  const poller = (async () => {
    while (!stop) {
      sweep();
      await sleep(POLL_MS);
    }
  })();
  /** @type {any} */
  let result;
  try {
    result = await run();
  } finally {
    stop = true;
    await poller;
  }
  sweep();
  return { created: [...created].sort(), result };
}

/**
 * 用**真 test runner**跑那两个文件（`stdio` 取管道，父进程同时在校验采样）。
 *
 * ⚠ `NODE_TEST_CONTEXT` 必须摘掉（实测踩过）：`node --test` 会给每个文件进程置这个变量
 * （这里是 `child-v8`），孙进程继承到它就会把自己当成「test runner 的子进程」——**一条用例都不跑、
 * 直接 exit 0、stdout 全空**。留着它，本守卫后面那三条反空转断言会把「什么都没跑」当绿，
 * 于是「扫描面零新增文件」也恒真（守卫静默失效）。
 * 只摘这一个变量，其余环境（CI 的 `NODE_OPTIONS` 等）原样继承 —— 要的就是 CI 的那个跑法。
 * @returns {Promise<{status: number|null, signal: string|null, stdout: string, stderr: string}>}
 */
function runPairInChildProcess() {
  return new Promise((done) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...PAIR], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // 只留尾巴：断言失败时要的是红字原文，不是全量 spec 输出。
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-20_000); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    const timer = setTimeout(() => { child.kill(); }, CHILD_TIMEOUT_MS);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      done({ status, signal, stdout, stderr });
    });
  });
}

test('正控制：采样器必须看得见「创建 → 一秒内删掉」的临时文件（否则下面那条守卫恒绿）', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'gy-scan-watch-'));
  try {
    const { created } = await pollForNewFiles([{ label: '', abs: sandbox }], async () => {
      await sleep(60); // 先让轮询跑起来，确保基线是在「空沙箱」上取的
      writeFileSync(join(sandbox, 'probe-temp.ts'), 'export const PROBE = 1;\n', 'utf8');
      await sleep(240); // 存活时间与 NC7 的临时宿主（旧树上 ≈1.2s）同量级偏短，采样器仍必须命中
      rmSync(join(sandbox, 'probe-temp.ts'), { force: true });
    });
    assert.deepEqual(
      created,
      ['probe-temp.ts'],
      '采样器没看见「创建后又删掉」的文件 ⇒ 本文件的第二条守卫没有牙齿（会把真竞态报成绿）',
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('并行跑 sql-column-coverage + s4-data-gap-pins：扫描面里不得出现任何新文件，且两个文件都必须 exit 0', async () => {
  const roots = SCAN_ROOTS.map((label) => ({ label, abs: join(REPO_ROOT, ...label.split('/')) }));
  for (const root of roots) {
    assert.equal(
      readdirSync(root.abs, { withFileTypes: true }).length > 0,
      true,
      `扫描面 ${root.label} 是空的 ⇒ 采样点搬走了，本守卫会退化成恒绿`,
    );
  }

  const { created, result } = await pollForNewFiles(roots, runPairInChildProcess);

  assert.deepEqual(
    created,
    [],
    '【扫描面被写了】并行跑 sql-column-coverage 与 s4-data-gap-pins 期间，这些树里出现了新文件：\n  '
      + `${created.join('\n  ')}\n`
      + '⇒ 谁写的，谁的「写 → 读 → 删」就会和 s4 的「枚举 → 逐文件读」抢同一个文件，全量单测偶发\n'
      + '   `判据位置不存在：…`（s4 的 readRepoText）假红。\n'
      + '⇒ 正确修法：把临时文件写进 `os.tmpdir()` 的 `mkdtempSync` 沙箱，并给被测函数**显式传根目录**\n'
      + '  （NC7 就是这么修的）；⛔ 不要靠删断言、`t.skip` 或 `--test-concurrency=1` 让它变绿。',
  );
  assert.equal(result.signal, null, `子 test runner 被信号 ${result.signal} 干掉（超时？）`);
  assert.equal(
    result.status,
    0,
    '两个文件同跑必须 exit 0（这就是全量单测偶发红的那条命令）。原文：\n'
      + `--- stdout(尾) ---\n${result.stdout}\n--- stderr(尾) ---\n${result.stderr}`,
  );

  // 反空转：子进程真的把两个文件都跑了，而不是「扫了 0 个文件也 exit 0」。
  assert.match(result.stdout, /NC7/, '子进程输出里没有 NC7 ⇒ 没跑到 sql-column-coverage');
  assert.match(result.stdout, /缺口 2/, '子进程输出里没有「缺口 2」⇒ 没跑到 s4-data-gap-pins');
  assert.equal(
    /判据位置不存在/.test(result.stdout + result.stderr),
    false,
    `子进程里出现了竞态红字：\n${result.stdout}\n${result.stderr}`,
  );
  console.log('[unit-suite-scan-write-isolation] 并行跑两个文件：扫描面零新增文件，exit 0');
});
