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
 *   6. **证据缺失的失败重试可恢复**（监工 1023 [P2]）：首轮「删除成功 + 证据写失败」之后，
 *      零行重试必须能补写一条**本轮实测为空**的证据（`removed:0`/`idempotency:0` + 本轮 cutoff），
 *      让在线态从 blocked 恢复；⛔ 不伪造首轮删除行数或原始时刻，⛔ 不重复追加。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ONLINE_PURGE_DRIVER_ERROR_CODES,
  onlinePurgeEvidenceRef,
  runOnlinePurgeBatch,
} from '../../services/api/src/privacy/online-purge-driver.ts';
import { deriveOnlineStates } from '../../services/api/src/privacy/online-state-derivation.ts';
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

test('证据落库/⑦：首轮删除成功＋证据写失败 → 端口恢复＋零行重试 ⇒ 补写「本轮实测为空」证据、在线态恢复、且不重复追加', async () => {
  // 监工 1023 [P2] 的针对性用例：这是**唯一**能覆盖「写失败」与「全 0 跳过」连续发生的组合。
  const target = requestId(10);
  const retryCutoff = '2026-04-02T00:00:00.000Z';
  /** append-only 台账（模拟 `deletion_requests.online_purge_evidence`；同一摘要不重复追加）。 */
  const ledger = [];
  const append = (input) => {
    const evidenceRef = onlinePurgeEvidenceRef(input);
    if (ledger.some((entry) => entry.evidenceRef === evidenceRef)) return false;
    ledger.push({
      module: input.module,
      removed: input.removed,
      idempotency: input.idempotency,
      purgedAt: input.purgedAt,
      evidenceRef,
    });
    return true;
  };
  let healthy = false;
  const evidence = {
    async record(input) {
      if (!healthy) throw Object.assign(new Error('注入：证据端口不可用'), { code: 'STORE_UNREACHABLE' });
      append(input);
    },
    async recordVerifiedEmpty(input) {
      if (!healthy) throw Object.assign(new Error('注入：证据端口不可用'), { code: 'STORE_UNREACHABLE' });
      if (ledger.some((entry) => entry.module === input.module)) return 'already-present';
      append(input);
      return 'recorded';
    },
  };
  const zeroPort = purgePort({
    favorites: { removed: 0, idempotency: 0 },
    history: { removed: 0, idempotency: 0 },
    messages: { removed: 0, idempotency: 0 },
    conversations: { removed: 0, idempotency: 0 },
  });
  const stateRow = (entries) => ({
    requestId: target,
    requestState: 'requested',
    onlineDueAt: DUE,
    evidence: entries,
  });
  const derive = (entries, now) =>
    deriveOnlineStates({ requestId: target, modules: [...USER_DATA_DELETION_MODULES], row: stateRow(entries), now });

  // (a) 首轮：四域各删 1 行（合计 4 行），但证据端口整轮失败 ⇒ 该请求 failed、持久证据为空、在线态 blocked。
  const first = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests: [candidate(target)],
    totalDue: 1,
    dryRun: false,
    purge: purgePort(),
    evidence,
  });
  assert.equal(first.rowsPurged, USER_DATA_DELETION_MODULES.length, '首轮确实删掉了四域各一行（合计 4）');
  assert.equal(first.failed, 1, '证据写不进去 ⇒ 该请求必须落 failed（不得谎称成功）');
  assert.equal(first.succeeded, 0);
  assert.equal(ledger.length, 0, '首轮持久证据必须为空（证据端口整轮失败）');
  assert.equal(derive([], new Date(CUTOFF)).overall, 'blocked', '到期却没有证据 ⇒ 在线态 blocked（⛔ 不得 completed）');

  // (b) 端口恢复 + **零行重试** ⇒ 四域各补一条「本轮实测为空」的证据，在线态不再是 blocked。
  healthy = true;
  const retry = await runOnlinePurgeBatch({
    cutoff: retryCutoff,
    limit: 10,
    requests: [candidate(target)],
    totalDue: 1,
    dryRun: false,
    purge: zeroPort,
    evidence,
  });
  assert.equal(retry.rowsPurged, 0, '重试时存储已空 ⇒ 本轮真实删除行数就是 0');
  assert.equal(retry.failed, 0, '端口恢复后不得再有失败行');
  assert.equal(retry.succeeded, 1, '补上凭据 ⇒ 该请求本轮收口（不再落 already_purged）');
  assert.equal(retry.skipReasons.already_purged ?? 0, 0);
  assert.equal(retry.evidence.length, USER_DATA_DELETION_MODULES.length, '四域必须各补一条证据');
  assert.equal(ledger.length, USER_DATA_DELETION_MODULES.length, '补写必须真的落进台账');
  const recovered = derive(ledger, new Date(retryCutoff));
  assert.equal(recovered.overall, 'completed', '补上「本轮实测为空」的证据后，在线态不得再是 blocked');
  assert.equal(
    recovered.modules.every((one) => one.state === 'completed'),
    true,
  );

  // (c) 再重试一次 ⇒ 幂等：证据数组不重复追加、读数稳定（已有证据 ⇒ 一条都不补）。
  const third = await runOnlinePurgeBatch({
    cutoff: '2026-04-03T00:00:00.000Z',
    limit: 10,
    requests: [candidate(target)],
    totalDue: 1,
    dryRun: false,
    purge: zeroPort,
    evidence,
  });
  assert.equal(ledger.length, USER_DATA_DELETION_MODULES.length, '第三轮不得再追加任何证据（append-only 不被撑爆）');
  assert.equal(third.skipReasons.already_purged, 1, '证据齐了 ⇒ 回到旧的 already_purged 口径');
  assert.equal(third.evidence.length, 0, '已有证据 ⇒ 报告里也不得冒出新证据行');
  assert.equal(derive(ledger, new Date('2026-04-03T00:00:00.000Z')).overall, 'completed', '读数稳定');

  // (d) 未伪造：补写条目只记**本轮**读数与本轮时刻，没有任何条目声称首轮那 4 行删除。
  assert.equal(
    ledger.every((entry) => entry.removed === 0),
    true,
    '补写条目必须 removed:0（本轮实测为空）',
  );
  assert.equal(
    ledger.every((entry) => entry.idempotency === 0),
    true,
    '补写条目必须 idempotency:0（本轮实测为空）',
  );
  assert.equal(
    ledger.every((entry) => entry.purgedAt === retryCutoff),
    true,
    '补写时刻必须是**补写轮次**的 cutoff（⛔ 不回填首轮时刻）',
  );
  assert.equal(
    ledger.some((entry) => entry.removed === USER_DATA_DELETION_MODULES.length),
    false,
    '⛔ 没有任何条目把首轮的 4 行删除记成事实（无凭据不补历史）',
  );
});
