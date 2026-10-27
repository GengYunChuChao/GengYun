/**
 * 永久守卫：`tests/integration/` 里**自起 PG 集群**的脚本，不许再从固定基址随机/顺序挑端口。
 *
 * 为什么需要它（真实事故，不是假想）：
 *   C05 那片 PR 的 CI 首跑，`real-pg-17.11` job 的「备份副本域」step 红在
 *   `could not bind IPv4 address "127.0.0.1": Address already in use` /
 *   `FATAL:  could not create any TCP/IP sockets` / `AssertionError: pg_ctl start 失败（status=1…）`。
 *   根因：`tests/integration/backup-purge-pg.mjs` 用 `55500 + randomInt(0, 500)` 挑端口，而
 *   **Linux 默认 ephemeral 区间是 32768–60999** —— 那条 runner 上任何出站连接的源端口都可能占住它，
 *   于是 `pg_ctl start` 偶发 EADDRINUSE。换一次 attempt 重跑就好，但那是运气不是修好。
 *   所以判据不是「这次过了」，而是「代码里不再出现那种挑法」。
 *
 * 正确的做法（本守卫钉的第二条）：端口必须向内核要 —— 共用工具
 * `tests/integration/lib/free-port.mjs` 的 `pickFreePort()`（`listen(0)` 现分配 + 上限重试）。
 *
 * ⛔ 零硬编码：**不写死脚本清单**，每次从目录扫，判据是「文件里出现单引号的 `'initdb'` 或
 * `'pg_ctl'`」—— 即「真的会起集群」。只连已有库的脚本（`admin-flags-pg.mjs` 等）在注释/报错文案里
 * 用反引号提 initdb，不含该模式，因此不会被误纳；新增的自起集群脚本会被自动纳入。
 *
 * 判据只看**代码行**（整行注释先剔除）；判据本体在 `tests/unit/lib/port-pick-guard.mjs`，
 * 与取证脚本共用同一份正则（避免「守卫一套、取证另一套」）。
 *
 * 反空转（守卫本身必须证明自己扫到了东西）：
 *  - 扫描面文件数 > 0、自起集群脚本数 > 0（并打印实际数量与名单）；
 *  - 判别函数用**合成样本**做正/负控制：`55600 + randomInt(0, 300)`、`55600 + Math.floor(Math.random()*400)`、
 *    `for (let candidate = 55436; …)` 必须被抓；`await pickFreePort()`、注释里的旧写法、区间外常量必须放行。
 *
 * 纯静态：只 `readFileSync` 读 `tests/integration/*.mjs`（**非递归**，`lib/` 子目录不在扫描面）。
 * ⛔ 不起库、不联网、不 spawn 子进程、不写任何文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FREE_PORT_IMPORT, inspectSource, lineViolates, scanPortPicking } from './lib/port-pick-guard.mjs';

const scan = scanPortPicking();

test('反空转：扫描面与自起集群脚本都非空（守卫必须真的扫到了东西）', () => {
  assert.ok(scan.files.length > 0, '扫描面为 0 个文件：目录扫错了，这条守卫等于没写');
  assert.ok(
    scan.clusterScripts.length > 0,
    '一个自起集群的脚本都没认出来（判据 `\'initdb\'|\'pg_ctl\'` 失效了）',
  );
  // 实测基线：15 个 .mjs。另有 `tests/integration/knowledge-native-pg.ps1`：Windows 手工辅助脚本，
  // 用 `'initdb.exe'` 拼名、CI 不跑、docs 明确「不是 node 测试、无断言语义」⇒ 不在扫描面。
  assert.ok(
    scan.clusterScripts.length >= 15,
    `自起集群脚本只有 ${scan.clusterScripts.length} 个（历史实测 15 个）——判据退化了？`,
  );
  console.log(
    `[port-picking] 扫描面 ${scan.files.length} 个 .mjs；自起集群 ${scan.clusterScripts.length} 个：`
      + scan.clusterScripts.join(', '),
  );
});

test('自起集群的脚本不许再从固定基址随机/顺序挑端口（应 0 命中）', () => {
  // 改造前（基线 `0a7a4fe6`）本判据命中 14 处：10 处 `常量 + randomInt` + 1 处 `常量 + Math.random`
  // + 3 处区间顺序扫。改造后命中数应为 0 —— 但仍然扫到了上面打印的那一批文件，
  // 所以「0 命中」不是因为扫描面空了。
  const detail = scan.hits.map(hit => `${hit.file}:${hit.line} [${hit.rule}] ${hit.text}`).join('\n');
  assert.deepEqual(
    scan.hits,
    [],
    `仍有 ${scan.hits.length} 处固定基址挑端口（这些端口落在 Linux ephemeral 区间 32768–60999 内，`
      + '起库会偶发 EADDRINUSE；改用 ./lib/free-port.mjs 的 pickFreePort()）：\n'
      + detail,
  );
  assert.ok(scan.files.length > 0, '同一次扫描里扫描面必须非空');
});

test('自起集群的脚本必须用共用挑端口工具（按 import 路径判）', () => {
  assert.deepEqual(
    scan.missingToolImport,
    [],
    `这些自起集群的脚本没有 import '${FREE_PORT_IMPORT}'：${scan.missingToolImport.join(', ')}`,
  );
  assert.ok(scan.clusterScripts.length > 0, '没有识别出任何自起集群脚本，第二条判据就是空转的');
});

test('自起集群的脚本必须真的用上工具返回值，不许 import 完就丢地上', () => {
  // 「import 了、也调了一次、然后自己写死端口」在文本上和正常用法只差一个赋值。
  // 这条判据要求出现 `= await pickFreePort()` 或 `return pickFreePort()`。
  assert.deepEqual(
    scan.missingToolUse,
    [],
    `这些自起集群的脚本 import 了 '${FREE_PORT_IMPORT}' 却没把 pickFreePort() 的结果赋出去/返回出去`
      + `（调用完就丢，端口其实是从别处写死的）：${scan.missingToolUse.join(', ')}`,
  );
  assert.ok(scan.clusterScripts.length > 0, '没有识别出任何自起集群脚本，这条判据就是空转的');
});

test('内存注入：丢返回值 / 行尾注释 / 中转变量 / 非 port 名中转，四种绕过都必须判红', () => {
  // 对抗审查方三个变异在旧判据下**全绿**（漏网），这里把它们钉成永久用例。
  // 注入方式：内存里拼一个「确实是自起集群脚本 + 确实 import 了工具」的源码，只换端口那几行。
  const header = [
    `import { pickFreePort } from '${FREE_PORT_IMPORT}';`,
    "const initdb = TOOL('initdb');",
    "const pgctl = TOOL('pg_ctl');",
  ].join('\n');
  const mutate = body => inspectSource('mutant.mjs', `${header}\n${body}\n`);

  // M3b：调了工具但把返回值丢掉，端口写在一个带 port 的变量里再赋给 port。
  const m3b = mutate('await pickFreePort();\nconst boundPort = 55488;\nport = boundPort;');
  assert.ok(m3b.isCluster, '注入样本必须被判成自起集群脚本，否则这条用例是空转');
  assert.ok(m3b.importsTool, '注入样本必须带工具 import，否则验不到「import 了还写死」这条');
  assert.deepEqual(
    m3b.violations.map(hit => hit.rule),
    ['端口写死成固定常量'],
    'M3b（丢返回值 + boundPort = 55488）必须被判红',
  );

  // M3c：无分号 + 行尾注释 —— 旧判据要求「数字后面紧跟 ; , ) 或行尾」，被行尾注释挡住就漏了。
  const m3c = mutate('port = 55488 // 兜底');
  assert.deepEqual(
    m3c.violations.map(hit => hit.rule),
    ['端口写死成固定常量'],
    'M3c（`port = 55488 // 兜底`）必须被判红',
  );

  // M3d：中转变量 port2 —— 名字不是 port/pgPort/portNumber/candidate，旧名单漏掉。
  const m3d = mutate('const port2 = 55488;\nport = port2;');
  assert.deepEqual(
    m3d.violations.map(hit => hit.rule),
    ['端口写死成固定常量'],
    'M3d（`const port2 = 55488; port = port2;`）必须被判红',
  );

  // M3e：中转变量连 port 字样都不带 —— 抓不到字面量，就靠「工具返回值没被用掉」抓。
  const m3e = mutate('await pickFreePort();\nconst seed = 55488;\nport = seed;');
  assert.equal(m3e.usesTool, false, 'M3e 的 pickFreePort() 返回值没被赋出去/返回出去，usesTool 必须为 false');
  assert.deepEqual(m3e.violations, [], 'M3e 的端口字面量叫 seed，字面量判据抓不到 —— 红只能来自 usesTool');

  // 负控制：正常写法必须放行（三种真实写法：赋值、循环内换候选、包装成 pickPort 返回）。
  for (const ok of [
    'const port = await pickFreePort();',
    'candidate = await pickFreePort();',
    'return pickFreePort();',
    'return await pickFreePort();',
  ]) {
    const sample = mutate(ok);
    assert.equal(sample.usesTool, true, `正常写法必须被判成「用上了工具」：${ok}`);
    assert.deepEqual(sample.violations, [], `正常写法不许被判红：${ok}`);
  }
});

test('判别函数自检：正控制必须红、负控制必须放行', () => {
  // 正控制（历史真实写法，逐字取自基线）：
  assert.equal(lineViolates('const port = 55500 + randomInt(0, 500);'), '常量基址 + randomInt/Math.random');
  assert.equal(
    lineViolates('    const candidate = 55600 + randomInt(0, 300);'),
    '常量基址 + randomInt/Math.random',
  );
  assert.equal(
    lineViolates('  const port = 55600 + Math.floor(Math.random() * 400);'),
    '常量基址 + randomInt/Math.random',
  );
  assert.equal(
    lineViolates('  for (let candidate = 55436; candidate <= 55467; candidate += 1) {'),
    '固定基址顺序扫区间',
  );
  assert.equal(
    lineViolates('  for (let candidate = 55600; candidate <= 55639; candidate += 1) {'),
    '固定基址顺序扫区间',
  );
  assert.equal(lineViolates('const port = 55488;'), '端口写死成固定常量');
  assert.equal(lineViolates('  port = 55500;'), '端口写死成固定常量');
  // 审查方三个变异改名/去分号/加行尾注释都要抓得住：
  assert.equal(lineViolates('  const boundPort = 55488;'), '端口写死成固定常量');
  assert.equal(lineViolates('  const port2 = 55488;'), '端口写死成固定常量');
  assert.equal(lineViolates('  port = 55488 // 兜底'), '端口写死成固定常量');

  // 负控制（必须放行）：
  assert.equal(lineViolates('  const port = await pickFreePort();'), null, '内核分配的写法必须放行');
  assert.equal(lineViolates('  const candidate = await pickFreePort();'), null);
  assert.equal(
    lineViolates('// ⛔ 原来 `55500 + randomInt(0, 500)` 会落进 ephemeral 区间'),
    null,
    '注释里的旧写法是证据，不是违规',
  );
  assert.equal(lineViolates(' * 端口原本是 55600 + randomInt(0, 300)'), null);
  assert.equal(lineViolates('  const MAX_PORT_ATTEMPTS = 8;'), null);
  // ephemeral 区间外的常量不归本判据管（例如既有实例 5432）：
  assert.equal(lineViolates('  const port = 5432 + randomInt(0, 3);'), null);
  assert.equal(lineViolates('  const port = 5432;'), null);
  // 非端口语义的数字不是违规（避免守卫误伤业务常量）：
  assert.equal(lineViolates('  const RETENTION_MS = 55488;'), null);
});
