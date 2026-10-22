/**
 * GY-R32 · #19 片B · **在线清理驱动的证据落库**（内存臂；真库臂见
 * `tests/integration/online-purge-pg.mjs` 的 [9]/[10] 组）。
 *
 * 判据（静态可见、与真库臂同源）：
 *   1. 每个成功 (request, module) 行**恰好**调用一次证据端口，参数是真实读数
 *      （requestId / module / removed / idempotency / purgedAt），并用同一条
 *      `onlinePurgeEvidenceRef()` 口径算出可复算的 `sha256:` 摘要；
 *   2. 失败行**不写**证据，且不阻塞同请求其它模块与后续请求（既有语义不变）；
 *   3. `already_purged`（四域全 0 行）与 `dry-run` 不写证据（不谎称本次干了活）；
 *   4. 证据端口自己抛错 ⇒ 该行记 `EVIDENCE_WRITE_FAILED` 失败（不吞、不谎称成功）；
 *   5. 重跑（0 行）不追加任何证据 ⇒ 「证据不重复」在驱动侧就成立。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ONLINE_PURGE_DRIVER_ERROR_CODES,
  onlinePurgeEvidenceRef,
  runOnlinePurgeBatch,
} from '../../services/api/src/privacy/online-purge-driver.ts';
import { USER_DATA_DELETION_MODULES } from '../../services/api/src/privacy/user-data-deletion.ts';

const CUTOFF = '2026-04-01T00:00:00.000Z';
const DUE = '2026-03-31T00:00:00.000Z';

function candidate(requestId, dueAt = DUE) {
  return { requestId, userId: `user-${requestId}`, onlineDueAt: dueAt };
}

function requestId(seed) {
  const tail = String(seed).padStart(12, '0');
  return `11111111-1111-4111-8111-${tail}`;
}

/** 记录全部证据写入（顺序保留：失败行不写 ⇒ 顺序本身就是判据）。 */
function memoryEvidence() {
  const rows = [];
  return {
    rows,
    async record(input) {
      rows.push({ ...input });
    },
  };
}

/** 按模块给出清除结果；未列出的模块返回 `{ removed: 1, idempotency: 0 }`。 */
function purgePort(perModule = {}) {
  return {
    async purgeModule({ module }) {
      const outcome = perModule[module];
      if (outcome instanceof Error) throw outcome;
      return outcome ?? { removed: 1, idempotency: 0 };
    },
  };
}

test('证据落库/①：每个成功 (request, module) 行各写一条，摘要可独立复算', async () => {
  const first = requestId(1);
  const evidence = memoryEvidence();
  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests: [candidate(first)],
    totalDue: 1,
    dryRun: false,
    purge: purgePort(),
    evidence,
  });

  assert.equal(report.failed, 0);
  assert.equal(report.succeeded, 1);
  assert.equal(evidence.rows.length, USER_DATA_DELETION_MODULES.length, '四域成功行必须各写一条证据');
  assert.deepEqual(
    evidence.rows.map((row) => row.module),
    [...USER_DATA_DELETION_MODULES],
    '证据顺序与模块闭集一致（不重排、不丢项）',
  );
  for (const row of evidence.rows) {
    assert.equal(row.requestId, first);
    assert.equal(row.removed, 1);
    assert.equal(row.idempotency, 0);
    assert.equal(typeof row.purgedAt, 'string');
    assert.match(row.purgedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const recomputed = onlinePurgeEvidenceRef({
      requestId: row.requestId,
      module: row.module,
      removed: row.removed,
      idempotency: row.idempotency,
    });
    const reported = report.evidence.find((item) => item.module === row.module)?.evidenceRef;
    assert.equal(
      recomputed,
      reported,
      '端口入参（读数）复算出的摘要必须与本轮报告里的 sha256 摘要逐字相等（同一条 onlinePurgeEvidenceRef 口径）',
    );
    assert.match(recomputed, /^sha256:[0-9a-f]{64}$/);
  }
});

test('证据落库/②：失败行不写证据，同请求其它模块与后续请求照跑', async () => {
  const bad = requestId(2);
  const good = requestId(3);
  const evidence = memoryEvidence();
  const flaky = purgePort();
  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests: [candidate(bad), candidate(good)],
    totalDue: 2,
    dryRun: false,
    purge: {
      async purgeModule(input) {
        // 只让**第一条请求**的 history 抛错：失败必须逐行隔离，不许连坐后续请求。
        if (input.requestId === bad && input.module === 'history') {
          throw Object.assign(new Error('注入：history 不可达'), { code: 'STORE_UNREACHABLE' });
        }
        return flaky.purgeModule(input);
      },
    },
    evidence,
  });

  assert.equal(report.failed, 1);
  assert.equal(report.succeeded, 1);
  assert.deepEqual(
    evidence.rows.map((row) => `${row.requestId}:${row.module}`),
    [
      `${bad}:favorites`,
      `${bad}:messages`,
      `${bad}:conversations`,
      `${good}:favorites`,
      `${good}:history`,
      `${good}:messages`,
      `${good}:conversations`,
    ],
    '抛错的那个 (request,module) 一行证据都不许写；其余成功行照写',
  );
  assert.equal(
    evidence.rows.some((row) => row.module === 'history' && row.requestId === bad),
    false,
    '失败模块不得留下证据',
  );
});

test('证据落库/③：四域全 0 行（already_purged）与 dry-run 都不写证据', async () => {
  const zero = memoryEvidence();
  const zeroReport = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests: [candidate(requestId(4))],
    totalDue: 1,
    dryRun: false,
    purge: purgePort({ favorites: { removed: 0, idempotency: 0 }, history: { removed: 0, idempotency: 0 }, messages: { removed: 0, idempotency: 0 }, conversations: { removed: 0, idempotency: 0 } }),
    evidence: zero,
  });
  assert.equal(zeroReport.skipped, 1);
  assert.equal(zeroReport.skipReasons.already_purged, 1);
  assert.equal(zero.rows.length, 0, '没删任何行 ⇒ 一条证据都不留（不谎称本次清过）');

  const dry = memoryEvidence();
  const dryReport = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests: [candidate(requestId(5))],
    totalDue: 1,
    dryRun: true,
    purge: purgePort(),
    evidence: dry,
  });
  assert.equal(dryReport.rowsPurged, 0);
  assert.equal(dry.rows.length, 0, 'dry-run 不得写任何证据');
});

test('证据落库/④：证据写入失败 ⇒ 该行 failed/EVIDENCE_WRITE_FAILED，不阻塞其它行', async () => {
  const first = requestId(6);
  const second = requestId(7);
  const rows = [];
  const evidence = {
    async record(input) {
      if (input.requestId === first && input.module === 'messages') {
        throw Object.assign(new Error('注入：证据写入失败'), { code: 'STORE_UNREACHABLE' });
      }
      rows.push({ ...input });
    },
  };
  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests: [candidate(first), candidate(second)],
    totalDue: 2,
    dryRun: false,
    purge: purgePort(),
    evidence,
  });

  assert.equal(report.failed, 1, '证据写不进去的那一行必须落 failed（否则「成功」无凭据）');
  assert.equal(report.succeeded, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].requestId, first);
  assert.equal(report.failures[0].module, 'messages');
  assert.equal(
    report.failures[0].errorCode,
    ONLINE_PURGE_DRIVER_ERROR_CODES.EVIDENCE_WRITE_FAILED,
    '证据写入失败必须是驱动自有分类码（不冒充模块安全码）',
  );
  assert.equal(
    rows.some((row) => row.requestId === first && row.module === 'messages'),
    false,
    '写失败的那一行不得被记成已写证据',
  );
  assert.equal(rows.filter((row) => row.requestId === second).length, USER_DATA_DELETION_MODULES.length);
});

test('证据落库/⑤：重跑 0 行不追加证据（证据不重复）', async () => {
  const target = requestId(8);
  const evidence = memoryEvidence();
  const options = {
    cutoff: CUTOFF,
    limit: 10,
    requests: [candidate(target)],
    totalDue: 1,
    dryRun: false,
    purge: purgePort(),
    evidence,
  };
  const firstRun = await runOnlinePurgeBatch(options);
  assert.equal(firstRun.succeeded, 1);
  assert.equal(evidence.rows.length, USER_DATA_DELETION_MODULES.length);

  const secondRun = await runOnlinePurgeBatch({
    ...options,
    purge: purgePort({
      favorites: { removed: 0, idempotency: 0 },
      history: { removed: 0, idempotency: 0 },
      messages: { removed: 0, idempotency: 0 },
      conversations: { removed: 0, idempotency: 0 },
    }),
  });
  assert.equal(secondRun.rowsPurged, 0);
  assert.equal(secondRun.skipReasons.already_purged, 1);
  assert.equal(
    evidence.rows.length,
    USER_DATA_DELETION_MODULES.length,
    '第二轮 0 行 ⇒ 证据条数不得变化（重跑不重复追加）',
  );
});

test('证据落库/⑥：不注入证据端口时行为与追加前逐字一致（不写、不报错）', async () => {
  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests: [candidate(requestId(9))],
    totalDue: 1,
    dryRun: false,
    purge: purgePort(),
  });
  assert.equal(report.succeeded, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.evidence.length, USER_DATA_DELETION_MODULES.length, '报告里的证据行仍在（旧口径不变）');
});
