// GY-R72 · W15（#6 缺口 G1）· 媒体对象回收驱动 · **纯逻辑**单测（不连库、不读系统时钟、不碰真桶）
//
// 被测对象：`services/api/src/media/purge-driver.ts`（`runMediaPurge()` / `formatMediaPurgeReport()` /
// `normalizeMediaPurgeLimit()`）与它的运维入口 `tools/purge-expired-media.mjs` 的**退出码**面。
//
// 覆盖的 8 件事：
//   [1] 正常一轮：先 `expireInitiated()` 再 `cleanupOrphans()`，读数映射正确、退出码 0；
//   [2] 到期 0 条时**仍然**跑孤儿清扫（两段互不阻塞，不是「没到期就整轮跳过」）；
//   [3] `cleanupOrphans()` 抛错 ⇒ 退出码 1 + 一条失败读数（含阶段/错误码/可重试性）；
//   [4] `dryRun` ⇒ 只调 `stats()`，⛔ 不调 `expireInitiated()`/`cleanupOrphans()`，不改任何数据；
//   [5] 对象端口抛错或返回 `false` ⇒ **未确认的删除不进 `deleted`**，记进 `retained`，引用与台账行
//       都留着，下一轮端口恢复后才真正删掉（口径照 `services/api/src/media/service.ts:704-751`：
//       `:708`/`:742` 明确「`deleteObject()` 不是 `true` ⇒ 保留引用与台账行，留给下一轮重试」）；
//   [6] `--limit` 非法 ⇒ 退出码 2（驱动层一次端口方法都不调；CLI 层同样退 2、⛔ 不退化成 0）；
//   [7] `stats()` 的 `objectCount` 为 `null`（适配器不提供对象枚举）⇒ dry-run **仍然退 0**，
//       读数写「未知」而**不是** 0（⛔ 不把「诊断不可用」读成「桶里只有 0 个对象」）；
//   [8] `cleanupOrphans()` 的 `remainingObjects` 为 `null` ⇒ **仍然退 0**，且不印计数行
//       （null 既可能是「适配器不枚举」也可能是「本轮没跑清扫」，两种都不是 0，不猜）。
//
// [7]/[8] 是 #795 打回后的返工点：真实 S3 适配器的 `objectCount()` 固定抛 `PROVIDER_UNAVAILABLE`
// （未接 list 权限），过去 `cleanupOrphans()` 无条件调它 ⇒ 每轮**已经成功**的清理都被折成一次失败、退 1。
// 现在适配器用 `objectCountSupported: false` 显式声明这条**诊断**能力不可用，服务层据此返回 `null`；
// 驱动层必须把这两个 `null` 当「读数未知」而不是失败。
//
// 本文件**不**证明的（见报告「诚实边界」）：真实 S3 的 `DeleteObject`/版本化语义、真 PG 上的并发行为、
// `#6` 的 G2/G3、任何剂量卡。本机没有真桶真库 ⇒ CLI 的端到端路径跑不了，这里只钉住可判的那一层。
//
// 另外：`service.ts` 里「未确认 ⇒ 保留引用与台账行」的**实现**由该文件自己的测试覆盖，本文件不重复证明；
// 这里验证的是驱动层**不会**把未确认的删除记成已删除（`deleted`/`retained` 的账要分得开）。
//
// 连库臂（真 PG + 真 S3 端口）留待装配片：`tests/integration/media-persistence-pg.mjs` 的既有形态。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MEDIA_PURGE_LIMIT,
  MAX_MEDIA_PURGE_LIMIT,
  MEDIA_PURGE_EXIT,
  MEDIA_PURGE_PHASES,
  MEDIA_PURGE_SKIP_REASONS,
  MediaPurgeArgumentError,
  formatMediaPurgeReport,
  normalizeMediaPurgeLimit,
  runMediaPurge,
} from '../../services/api/src/media/purge-driver.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO_ROOT, 'tools', 'purge-expired-media.mjs');

/** 固定时钟：驱动层不读系统时钟，时间点由用例决定（两处读数同源，所以可以是同一个值）。 */
const FIXED_NOW = () => new Date('2026-10-31T00:00:00.000Z');

/** 造一个错误对象（带 `code`/`retryable`，形状与 `services/api/src/errors.ts` 的 `ApiError` 一致）。 */
function apiError(code, message, { retryable = false } = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

/**
 * 假媒体服务端口：形状与 `createAppMediaService()` 返回值的三个方法是同一套契约。
 *
 * `objectPort(ref)` 模拟**对象存储端口**（`MediaObjectStore.deleteObject`）：返回 `true` 才算删掉；
 * 返回 `false` 或抛错 ⇒ 该引用与它的台账行都留着、计入 `pendingObjects`
 * （这就是 `service.ts:704-751` 的口径，本夹具照抄，供驱动层的记账用例使用）。
 */
function createFakeMediaService({
  expired = 0,
  objectRefs = [],
  objectPort = async () => true,
  stats = { mediaCount: 7, objectCount: 3, grantCount: 2 },
  expireError = null,
  cleanupError = null,
  statsError = null,
  revokedGrants = 0,
  // `null` = 端口声明「不提供对象枚举」（真实 S3 的形状）；`undefined` = 照替身口径报真实条数。
  remainingObjects,
} = {}) {
  const calls = [];
  const refs = [...objectRefs];
  const ledger = refs.map((ref) => ({ ref }));
  const state = { refs, ledger, objectPort, revokedGrants };

  const mediaService = {
    async expireInitiated() {
      calls.push('expireInitiated');
      if (expireError !== null) throw expireError;
      return { expired };
    },
    async cleanupOrphans() {
      calls.push('cleanupOrphans');
      if (cleanupError !== null) throw cleanupError;
      let removedObjects = 0;
      let pendingObjects = 0;
      for (const ref of [...state.refs]) {
        let confirmed = false;
        try {
          confirmed = (await state.objectPort(ref)) === true;
        } catch {
          // 端口抛错 ⇒ 与返回 false 同等对待：没确认就是没删掉（不吞掉、也不算成功）。
          confirmed = false;
        }
        if (confirmed) {
          const at = state.refs.indexOf(ref);
          if (at >= 0) state.refs.splice(at, 1);
          state.ledger = state.ledger.filter((row) => row.ref !== ref);
          removedObjects += 1;
        } else {
          pendingObjects += 1;
          if (!state.ledger.some((row) => row.ref === ref)) state.ledger.push({ ref });
        }
      }
      return {
        removedObjects,
        revokedGrants: state.revokedGrants,
        pendingObjects,
        remainingObjects: remainingObjects === undefined ? state.refs.length : remainingObjects,
      };
    },
    async stats() {
      calls.push('stats');
      if (statsError !== null) throw statsError;
      return stats;
    },
  };

  return { mediaService, calls, state };
}

// ---------------------------------------------------------------------------- [1]

test('[1] 正常一轮：先 expireInitiated() 再 cleanupOrphans()，读数与退出码都对得上', async () => {
  const fake = createFakeMediaService({
    expired: 2,
    objectRefs: ['obj-raw-1', 'obj-deriv-1'],
    revokedGrants: 3,
  });

  const report = await runMediaPurge({ mediaService: fake.mediaService, now: FIXED_NOW });

  assert.deepEqual(fake.calls, ['expireInitiated', 'cleanupOrphans'], '两段的顺序固定：先收到期、再扫孤儿');
  assert.equal(report.exitCode, MEDIA_PURGE_EXIT.OK);
  assert.deepEqual(report.failures, []);
  assert.equal(report.expired, 2);
  assert.equal(report.orphansScanned, 2, '扫描数 = 确认删除 + 未确认');
  assert.equal(report.deleted, 2);
  assert.equal(report.retained, 0);
  assert.equal(report.revokedGrants, 3);
  assert.equal(report.remainingObjects, 0);
  assert.equal(report.dryRun, false);
  assert.equal(report.limit, DEFAULT_MEDIA_PURGE_LIMIT);
  assert.equal(report.truncated, false);
  assert.equal(report.skipReason, null);
  assert.equal(report.startedAt, '2026-10-31T00:00:00.000Z');
  assert.equal(report.finishedAt, '2026-10-31T00:00:00.000Z');
  assert.equal(report.scan, null, '非 dry-run 不做只读计数扫描');

  // 台账与外键都清干净了，这是「确认删除」的唯一含义。
  assert.deepEqual(fake.state.refs, []);
  assert.deepEqual(fake.state.ledger, []);

  // 读数可 JSON 化（CLI 的 --json 用它），且**不含对象键**（不把引用/凭据写进日志）。
  const serialized = JSON.stringify(report);
  assert.deepEqual(JSON.parse(serialized), report);
  assert.equal(serialized.includes('obj-raw-1'), false);
  assert.equal(serialized.includes('obj-deriv-1'), false);

  const lines = formatMediaPurgeReport(report);
  assert.ok(lines.length >= 3);
  assert.equal(lines.join('\n').includes('obj-raw-1'), false, '读数行不得回显对象键');
  assert.equal(lines.join('\n').includes('确认删除 2'), true);
});

// ---------------------------------------------------------------------------- [2]

test('[2] 到期 0 条：仍然跑 cleanupOrphans()（不是「没到期就整轮跳过」）', async () => {
  const fake = createFakeMediaService({ expired: 0, objectRefs: ['obj-left-over'] });

  const report = await runMediaPurge({ mediaService: fake.mediaService, now: FIXED_NOW });

  assert.deepEqual(fake.calls, ['expireInitiated', 'cleanupOrphans']);
  assert.equal(report.expired, 0);
  assert.equal(report.deleted, 1, '上一轮遗留的孤儿必须在本轮被扫到');
  assert.equal(report.retained, 0);
  assert.equal(report.truncated, false, '到期 0 条不会触发预算闸（0 < limit）');
  assert.equal(report.exitCode, MEDIA_PURGE_EXIT.OK);
});

// ---------------------------------------------------------------------------- [3]

test('[3] cleanupOrphans() 抛错 ⇒ 退出码 1 + 一条失败读数，且到期回收的读数保留', async () => {
  const fake = createFakeMediaService({
    expired: 3,
    cleanupError: apiError('ECONNRESET', '媒体域数据库连接中断（模拟）', { retryable: true }),
  });

  const report = await runMediaPurge({ mediaService: fake.mediaService, now: FIXED_NOW });

  assert.deepEqual(fake.calls, ['expireInitiated', 'cleanupOrphans'], '第二段抛错不影响第一段已发生的事实');
  assert.equal(report.exitCode, MEDIA_PURGE_EXIT.FAILED, '有失败读数 ⇒ 1（cron 要能看见）');
  assert.equal(report.expired, 3, '第一段的读数不能被第二段的失败抹掉');
  assert.equal(report.deleted, 0);
  assert.equal(report.retained, 0);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].phase, MEDIA_PURGE_PHASES.CLEANUP_ORPHANS);
  assert.equal(report.failures[0].code, 'ECONNRESET');
  assert.equal(report.failures[0].retryable, true);
  assert.match(report.failures[0].message, /模拟/);

  // 失败读数里不许出现连接串/密钥一类的东西（夹具没有，但形状要钉住：只有阶段/码/可重试性/说明）。
  assert.deepEqual(Object.keys(report.failures[0]).sort(), ['code', 'message', 'phase', 'retryable']);
});

// ---------------------------------------------------------------------------- [4]

test('[4] dryRun：只调 stats()，⛔ 不调 expireInitiated()/cleanupOrphans()，不改任何数据', async () => {
  const fake = createFakeMediaService({ expired: 9, objectRefs: ['obj-raw-1', 'obj-deriv-1'] });

  const report = await runMediaPurge({ mediaService: fake.mediaService, now: FIXED_NOW, dryRun: true });

  assert.deepEqual(fake.calls, ['stats'], 'dry-run 只走只读计数，一次写入型方法都不许调');
  assert.equal(report.dryRun, true);
  assert.equal(report.exitCode, MEDIA_PURGE_EXIT.OK);
  assert.equal(report.skipReason, MEDIA_PURGE_SKIP_REASONS.DRY_RUN);
  assert.deepEqual(report.scan, { mediaCount: 7, objectCount: 3, grantCount: 2 });
  assert.equal(report.expired, 0, 'dry-run 不报到期条数（只读路径算不出整批会收多少条）');
  assert.equal(report.deleted, 0);
  assert.equal(report.retained, 0);
  assert.equal(report.truncated, false);

  // 数据一个字节都没动。
  assert.deepEqual(fake.state.refs, ['obj-raw-1', 'obj-deriv-1']);
  assert.equal(fake.state.ledger.length, 2);

  const lines = formatMediaPurgeReport(report);
  assert.equal(lines[0].includes('dry-run'), true);
  assert.equal(lines.join('\n').includes('无法预知'), true, 'dry-run 必须自陈「算不出会到期多少条」');
});

// ---------------------------------------------------------------------------- [5]

test('[5] 对象端口抛错/返回 false ⇒ 不算删掉：记进 retained，引用与台账行都留着，下一轮才删', async () => {
  const behaviours = {
    'obj-throws': () => {
      throw new Error('S3 503（模拟）');
    },
    'obj-false': () => false,
    'obj-ok': () => true,
  };
  // 第一轮：一个引用抛错、一个引用返回 false ⇒ 两条都不算删掉。
  let live = 'degraded';
  const fake = createFakeMediaService({
    objectRefs: ['obj-throws', 'obj-false'],
    objectPort: (ref) => (live === 'degraded' ? behaviours[ref]() : true),
  });

  const first = await runMediaPurge({ mediaService: fake.mediaService, now: FIXED_NOW });

  assert.equal(first.exitCode, MEDIA_PURGE_EXIT.OK, '端口故障由 service 层折成 pending，不是驱动层的失败行');
  assert.deepEqual(first.failures, []);
  assert.equal(first.deleted, 0, '没有一条被确认删除 ⇒ deleted 必须是 0（⛔ 不许把未确认算成已删）');
  assert.equal(first.retained, 2, '两条都记进 retained（口径照 service.ts:708/742）');
  assert.equal(first.orphansScanned, 2);
  assert.deepEqual(fake.state.refs, ['obj-throws', 'obj-false'], '对象引用必须原样留着');
  assert.deepEqual(fake.state.ledger, [{ ref: 'obj-throws' }, { ref: 'obj-false' }], '台账行也必须留着');

  const degradedLines = formatMediaPurgeReport(first).join('\n');
  assert.equal(degradedLines.includes('未确认 2'), true, '读数要把「未确认」写出来，而不是只写「已清理」');

  // 第二轮：端口恢复 ⇒ 上一轮留着的两条才真正删掉。
  live = 'ok';
  const second = await runMediaPurge({ mediaService: fake.mediaService, now: FIXED_NOW });

  assert.equal(second.deleted, 2, '下一轮端口恢复后重试成功');
  assert.equal(second.retained, 0);
  assert.deepEqual(fake.state.refs, []);
  assert.deepEqual(fake.state.ledger, []);
});

// ---------------------------------------------------------------------------- [6]

test('[6] --limit 非法 ⇒ 2（驱动层一次端口方法都不调；CLI 层同样退 2，不退化成 0）', async () => {
  // 驱动层：非法 limit 属于「没跑」，必须在碰端口之前就判定。
  for (const bad of ['abc', '0', '-1', '5.5', '2e3', '', MAX_MEDIA_PURGE_LIMIT + 1]) {
    const fake = createFakeMediaService({ expired: 1, objectRefs: ['obj-raw-1'] });
    const report = await runMediaPurge({ mediaService: fake.mediaService, now: FIXED_NOW, limit: bad });
    assert.equal(report.exitCode, MEDIA_PURGE_EXIT.CONFIG, `limit=${JSON.stringify(bad)} 应当退 2`);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].phase, MEDIA_PURGE_PHASES.CONFIG);
    assert.equal(report.failures[0].code, 'INVALID_LIMIT');
    assert.deepEqual(fake.calls, [], '参数错 ⇒ 一个端口方法都不许调');
    assert.equal(report.expired, 0);
  }

  // 合法值原样通过（含字符串形态，CLI 只能给出字符串）。
  assert.equal(normalizeMediaPurgeLimit(undefined), DEFAULT_MEDIA_PURGE_LIMIT);
  assert.equal(normalizeMediaPurgeLimit('50'), 50);
  assert.equal(normalizeMediaPurgeLimit(MAX_MEDIA_PURGE_LIMIT), MAX_MEDIA_PURGE_LIMIT);
  assert.throws(() => normalizeMediaPurgeLimit('abc'), MediaPurgeArgumentError);

  // 端口/时钟未装配同样是「没跑」（退 2），不是「跑了 0 条」（退 0）。
  const noPort = await runMediaPurge({ mediaService: {}, now: FIXED_NOW });
  assert.equal(noPort.exitCode, MEDIA_PURGE_EXIT.CONFIG);
  assert.equal(noPort.failures[0].code, 'MISSING_MEDIA_PORT');
  const noClock = await runMediaPurge({ mediaService: createFakeMediaService().mediaService, now: null });
  assert.equal(noClock.exitCode, MEDIA_PURGE_EXIT.CONFIG);
  assert.equal(noClock.startedAt, null);

  // CLI 层：只有 argv/环境变量校验，不碰库不碰桶，所以这三条在本机也能跑。
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '', MEDIA_OBJECT_REF_KEY: '', ...env },
    });

  const badLimit = run(['--limit', 'abc']);
  assert.equal(badLimit.status, MEDIA_PURGE_EXIT.CONFIG, `CLI --limit abc 应当退 2：${badLimit.stderr}`);
  assert.match(badLimit.stderr, /--limit 必须是十进制正整数/);

  const noDsn = run([]);
  assert.equal(noDsn.status, MEDIA_PURGE_EXIT.CONFIG, `CLI 缺 DATABASE_URL 应当退 2：${noDsn.stderr}`);
  assert.match(noDsn.stderr, /缺少 DATABASE_URL/);

  const badDsn = run(['--limit', '10'], { DATABASE_URL: 'mysql://nope' });
  assert.equal(badDsn.status, MEDIA_PURGE_EXIT.CONFIG);
  assert.match(badDsn.stderr, /postgres/);

  // --help 是唯一退 0 的「什么都没跑」。
  const help = run(['--help']);
  assert.equal(help.status, MEDIA_PURGE_EXIT.OK);
  assert.match(help.stdout, /用法/);
  assert.match(help.stdout, /预算闸/, '用法里必须写清 --limit 不是到期条数的上限');
});

// ---------------------------------------------------------------------------- [7]

test('[7] stats() 的 objectCount 为 null（适配器不枚举）⇒ dry-run 仍退 0，读数写「未知」而不是 0', async () => {
  const fake = createFakeMediaService({
    objectRefs: ['obj-raw-1'],
    // 真实 S3 适配器的形状：媒体/授权计数照实报，对象计数**不提供**。
    stats: { mediaCount: 7, objectCount: null, grantCount: 2 },
  });

  const report = await runMediaPurge({ mediaService: fake.mediaService, now: FIXED_NOW, dryRun: true });

  assert.equal(report.exitCode, MEDIA_PURGE_EXIT.OK, '诊断能力不可用⛔ 不是失败（#795 打回点）');
  assert.deepEqual(report.failures, []);
  assert.deepEqual(fake.calls, ['stats']);
  assert.deepEqual(report.scan, { mediaCount: 7, objectCount: null, grantCount: 2 }, '不可用就读成 null，⛔ 不读成 0');
  assert.equal(report.scan.objectCount === 0, false);

  const text = formatMediaPurgeReport(report).join('\n');
  assert.equal(text.includes('未知'), true, '读数必须显式写「未知」，不能省掉这一项');
  assert.equal(text.includes('object=0'), false, '⛔ 不许把「不提供枚举」印成 0 个对象');
  assert.equal(text.includes('object=未知'), true);
});

// ---------------------------------------------------------------------------- [8]

test('[8] cleanupOrphans() 的 remainingObjects 为 null ⇒ 仍退 0，且不印计数行（不可用 ≠ 0 ≠ 失败）', async () => {
  const fake = createFakeMediaService({
    expired: 1,
    objectRefs: ['obj-raw-1', 'obj-deriv-1'],
    remainingObjects: null,
  });

  const report = await runMediaPurge({ mediaService: fake.mediaService, now: FIXED_NOW });

  assert.equal(report.exitCode, MEDIA_PURGE_EXIT.OK, '清扫本身成功，只是「清扫后还剩几个」读不出来');
  assert.deepEqual(report.failures, []);
  assert.equal(report.deleted, 2, '删除读数照常：诊断不可用不影响「确认删除了几条」');
  assert.equal(report.retained, 0);
  assert.equal(report.remainingObjects, null);
  assert.deepEqual(fake.state.refs, [], '对象引用确实被删掉了');
  assert.deepEqual(fake.state.ledger, []);

  const text = formatMediaPurgeReport(report).join('\n');
  assert.equal(text.includes('清扫后对象计数'), false, 'null 时不印计数行（也不印 0）');
  assert.equal(text.includes('确认删除 2'), true);

  // 读数照样可 JSON 化：null 原样序列化，不会被折叠成 0。
  assert.equal(JSON.parse(JSON.stringify(report)).remainingObjects, null);
});
