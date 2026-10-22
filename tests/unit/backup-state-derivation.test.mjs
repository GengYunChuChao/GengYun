// GY-R28 · W6（#19 G5/G11）· 回执 `backupState` 由真实副本行推导 · **纯逻辑**单测（不连库、不读系统时钟）
//
// 本文件只验证 `services/api/src/privacy/backup-state-derivation.ts`：
//   [1] 四域齐备 + 每行已清 + 证据可复算 ⇒ `completed`（这是「四域齐 ⇒ completed」的唯一通路）；
//   [2] 缺域 / 无行 ⇒ `blocked`（⛔「没有副本行」不许读成「清完了」）；
//   [3] 未到期 ⇒ `pending`（`pending` 的唯一正当语义），到期未清 ⇒ `blocked`（不是 pending）；
//   [4] `failed` 行 ⇒ `blocked/STORE_REJECTED`（重放不自愈）；
//   [5] 已清但证据缺失/对不上 ⇒ `blocked/EVIDENCE_REQUIRED`（⛔ 不降级成 pending）；
//   [6] 聚合口径：四域全 completed 才 overall=completed；缺一域永远到不了 completed；
//   [7] 只读端口：SQL 只 SELECT、列全在已授权面内、每次调用都重读、非 UUID 直接拒。
//
// 真库读数在 `tests/integration/online-purge-pg.mjs` 的臂 C（未取得 PG 二进制 ⇒ 77 跳过）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { purgeEvidenceRef } from '../../packages/privacy/backup-copies.mjs';
import {
  BACKUP_STATE_REASONS,
  createPostgresBackupStateReader,
  createUnwiredBackupStateReader,
  deriveBackupStateForModule,
  deriveBackupStates,
  unreadableBackupStates,
} from '../../services/api/src/privacy/backup-state-derivation.ts';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '11111111-1111-4111-8111-000000000001';
const MODULES = ['favorites', 'history', 'messages', 'conversations'];
const NOW = new Date('2026-10-21T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;

/** 造一行副本清单（默认：已清、证据由 `purgeEvidenceRef` 复算、30 日窗口已过）。 */
function copyRow(module, options = {}) {
  const { scope = scopeOf(module), state = 'purged', offsetMs = -DAY, digest = digestOf(module), evidence } = options;
  const payloadDigest = digest;
  const row = {
    module,
    scope,
    state,
    retentionUntil: new Date(NOW.getTime() + offsetMs),
    payloadDigest,
    evidenceRef: null,
  };
  row.evidenceRef =
    evidence === undefined
      ? state === 'purged'
        ? purgeEvidenceRef({ requestId: REQUEST_ID, module, payloadDigests: [payloadDigest] })
        : null
      : evidence;
  return row;
}

function scopeOf(module) {
  return { favorites: 'favorite', history: 'history', messages: 'message', conversations: 'conversation' }[module];
}

function digestOf(module) {
  // 64 位十六进制的稳定假摘要（不同域不同值，形态与 `payload_digest` CHECK 一致）。
  return module
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, 'a');
}

/** 四域各一行、全部已清且证据可复算 —— 这是「四域齐备」的基准态。 */
function allClearedRows() {
  return MODULES.map((module) => copyRow(module));
}

/** 驼峰逻辑行 → 库返回的蛇形原始行（验证端口的形状转换）。 */
function toPgRow(row) {
  return {
    module: row.module,
    scope: row.scope,
    state: row.state,
    retention_until: row.retentionUntil,
    payload_digest: row.payloadDigest,
    evidence_ref: row.evidenceRef,
  };
}

// ---------------------------------------------------------------- [1] 四域齐 ⇒ completed

test('[1] 四域齐备 + 每行已清 + 证据可复算 ⇒ 每域 completed 且聚合 completed', () => {
  const derived = deriveBackupStates({ requestId: REQUEST_ID, modules: MODULES, rows: allClearedRows(), now: NOW });

  assert.equal(derived.overall, 'completed');
  assert.deepEqual(derived.missingModules, []);
  assert.equal(derived.modules.length, 4);
  for (const one of derived.modules) {
    assert.equal(one.state, 'completed', `${one.module} 应为 completed`);
    assert.equal(one.reason, BACKUP_STATE_REASONS.PURGED_WITH_EVIDENCE);
    assert.equal(one.errorCode, null);
    assert.equal(one.copies, 1);
    assert.equal(
      one.evidenceRef,
      purgeEvidenceRef({ requestId: REQUEST_ID, module: one.module, payloadDigests: [digestOf(one.module)] }),
      '回执里的证据必须等于按这一组摘要复算出的那一个',
    );
  }
});

test('[1b] 同域多 scope 时证据覆盖全部行（不是只看第一行）', () => {
  // 真端口给**同一域的所有行**写同一个证据串（由整组摘要复算），因此这里也照此造数。
  const messagesEvidence = purgeEvidenceRef({
    requestId: REQUEST_ID,
    module: 'messages',
    payloadDigests: [digestOf('messages'), 'b'.repeat(64)],
  });
  const rows = [
    ...MODULES.filter((module) => module !== 'messages').map((module) => copyRow(module)),
    copyRow('messages', { scope: 'message', evidence: messagesEvidence }),
    copyRow('messages', { scope: 'message', digest: 'b'.repeat(64), evidence: messagesEvidence }),
  ];
  const derived = deriveBackupStates({ requestId: REQUEST_ID, modules: MODULES, rows, now: NOW });
  const messages = derived.modules.find((one) => one.module === 'messages');
  assert.equal(messages.copies, 2);
  assert.equal(messages.state, 'completed');
  assert.equal(messages.evidenceRef, messagesEvidence);
  assert.equal(derived.overall, 'completed');
});

// ---------------------------------------------------------------- [2] 缺域

test('[2] 少一域 ⇒ blocked/MANIFEST_MISSING 且 missingModules 指名道姓（⛔ 不许 completed）', () => {
  const rows = allClearedRows().filter((row) => row.module !== 'conversations');
  const derived = deriveBackupStates({ requestId: REQUEST_ID, modules: MODULES, rows, now: NOW });

  assert.equal(derived.overall, 'blocked', '只清了三个域不能读成整体完成');
  assert.deepEqual(derived.missingModules, ['conversations']);
  const missing = derived.modules.find((one) => one.module === 'conversations');
  assert.equal(missing.state, 'blocked');
  assert.equal(missing.reason, BACKUP_STATE_REASONS.MANIFEST_MISSING);
  assert.equal(missing.errorCode, 'EVIDENCE_REQUIRED');
  assert.equal(missing.copies, 0);
  assert.equal(missing.evidenceRef, null);
});

test('[2b] 一行都没有 ⇒ 四域全 blocked（「没有副本行」≠「清干净了」）', () => {
  const derived = deriveBackupStates({ requestId: REQUEST_ID, modules: MODULES, rows: [], now: NOW });
  assert.equal(derived.overall, 'blocked');
  assert.deepEqual(derived.missingModules, MODULES);
  for (const one of derived.modules) {
    assert.equal(one.state, 'blocked');
    assert.equal(one.reason, BACKUP_STATE_REASONS.MANIFEST_MISSING);
  }
});

// ---------------------------------------------------------------- [3] 未到期 / 到期未清

test('[3] 还有未到期行 ⇒ pending/RETAINED_NOT_DUE（pending 的唯一正当语义）', () => {
  const rows = [
    copyRow('favorites', { state: 'pending_purge', offsetMs: +5 * DAY, evidence: null }),
    copyRow('history', { state: 'pending_purge', offsetMs: +5 * DAY, evidence: null }),
    copyRow('messages', { state: 'pending_purge', offsetMs: +5 * DAY, evidence: null }),
    copyRow('conversations', { state: 'pending_purge', offsetMs: +5 * DAY, evidence: null }),
  ];
  const derived = deriveBackupStates({ requestId: REQUEST_ID, modules: MODULES, rows, now: NOW });

  assert.equal(derived.overall, 'pending');
  for (const one of derived.modules) {
    assert.equal(one.state, 'pending');
    assert.equal(one.reason, BACKUP_STATE_REASONS.RETAINED_NOT_DUE);
    assert.equal(one.errorCode, null);
  }
});

test('[3b] 到期却未清 ⇒ blocked/PURGE_DUE_NOT_EXECUTED（不是 pending：pending 意味着「还没轮到」）', () => {
  const rows = MODULES.map((module) => copyRow(module, { state: 'pending_purge', offsetMs: -DAY, evidence: null }));
  const derived = deriveBackupStates({ requestId: REQUEST_ID, modules: MODULES, rows, now: NOW });

  assert.equal(derived.overall, 'blocked');
  for (const one of derived.modules) {
    assert.equal(one.state, 'blocked');
    assert.equal(one.reason, BACKUP_STATE_REASONS.PURGE_DUE_NOT_EXECUTED);
    assert.equal(one.errorCode, 'STORE_REJECTED');
  }
});

test('[3c] 同域「一半到期未清 + 一半未到期」⇒ 仍判 blocked（到期优先于等待）', () => {
  const rows = [
    ...MODULES.filter((module) => module !== 'favorites').map((module) => copyRow(module)),
    copyRow('favorites', { scope: 'favorite', offsetMs: -DAY, state: 'pending_purge', evidence: null }),
    copyRow('favorites', { scope: 'favorite', offsetMs: +10 * DAY, state: 'pending_purge', evidence: null, digest: 'c'.repeat(64) }),
  ];
  const derived = deriveBackupStates({ requestId: REQUEST_ID, modules: MODULES, rows, now: NOW });
  const favorites = derived.modules.find((one) => one.module === 'favorites');
  assert.equal(favorites.state, 'blocked');
  assert.equal(favorites.reason, BACKUP_STATE_REASONS.PURGE_DUE_NOT_EXECUTED);
});

test('[3d] 到期边界是闭区间：retention_until 恰好等于 now ⇒ 已到期 ⇒ blocked', () => {
  const one = deriveBackupStateForModule({
    requestId: REQUEST_ID,
    module: 'favorites',
    rows: [copyRow('favorites', { state: 'pending_purge', offsetMs: 0, evidence: null })],
    now: NOW,
  });
  assert.equal(one.state, 'blocked');
  assert.equal(one.reason, BACKUP_STATE_REASONS.PURGE_DUE_NOT_EXECUTED);
});

// ---------------------------------------------------------------- [4] failed 行

test('[4] 有 failed 行 ⇒ blocked/COPY_FAILED/STORE_REJECTED（重放不会自愈）', () => {
  const rows = [
    copyRow('favorites', { state: 'failed', evidence: null }),
    ...MODULES.filter((module) => module !== 'favorites').map((module) => copyRow(module)),
  ];
  const derived = deriveBackupStates({ requestId: REQUEST_ID, modules: MODULES, rows, now: NOW });
  const favorites = derived.modules.find((one) => one.module === 'favorites');
  assert.equal(favorites.state, 'blocked');
  assert.equal(favorites.reason, BACKUP_STATE_REASONS.COPY_FAILED);
  assert.equal(favorites.errorCode, 'STORE_REJECTED');
  assert.equal(derived.overall, 'blocked');
});

test('[4b] 行输入非法（state 不在闭集）⇒ blocked/INPUT_INVALID/POLICY_BLOCKED，不猜', () => {
  const one = deriveBackupStateForModule({
    requestId: REQUEST_ID,
    module: 'favorites',
    rows: [copyRow('favorites', { state: 'weird_state', evidence: null })],
    now: NOW,
  });
  assert.equal(one.state, 'blocked');
  assert.equal(one.reason, BACKUP_STATE_REASONS.INPUT_INVALID);
  assert.equal(one.errorCode, 'POLICY_BLOCKED');
});

// ---------------------------------------------------------------- [5] 证据

test('[5] 已清但 evidence_ref 为空 ⇒ blocked/EVIDENCE_REQUIRED（⛔ 不降级成 pending）', () => {
  const rows = [copyRow('favorites', { evidence: '' }), ...MODULES.filter((m) => m !== 'favorites').map((m) => copyRow(m))];
  const derived = deriveBackupStates({ requestId: REQUEST_ID, modules: MODULES, rows, now: NOW });
  const favorites = derived.modules.find((one) => one.module === 'favorites');
  assert.equal(favorites.state, 'blocked');
  assert.equal(favorites.reason, BACKUP_STATE_REASONS.EVIDENCE_MISSING);
  assert.equal(favorites.errorCode, 'EVIDENCE_REQUIRED');
  assert.equal(derived.overall, 'blocked');
});

test('[5b] 已清但证据串对不上复算结果（伪造/错位）⇒ blocked/EVIDENCE_REQUIRED', () => {
  const forged = `sha256:${'f'.repeat(64)}`;
  const rows = [copyRow('favorites', { evidence: forged }), ...MODULES.filter((m) => m !== 'favorites').map((m) => copyRow(m))];
  const derived = deriveBackupStates({ requestId: REQUEST_ID, modules: MODULES, rows, now: NOW });
  const favorites = derived.modules.find((one) => one.module === 'favorites');
  assert.equal(favorites.state, 'blocked');
  assert.equal(favorites.reason, BACKUP_STATE_REASONS.EVIDENCE_MISSING);
  assert.equal(favorites.errorCode, 'EVIDENCE_REQUIRED');
});

test('[5c] 证据串属于别的请求/别的域 ⇒ 也对不上 ⇒ blocked', () => {
  const elsewhere = purgeEvidenceRef({
    requestId: '00000000-0000-4000-8000-0000000000ff',
    module: 'favorites',
    payloadDigests: [digestOf('favorites')],
  });
  const one = deriveBackupStateForModule({
    requestId: REQUEST_ID,
    module: 'favorites',
    rows: [copyRow('favorites', { evidence: elsewhere })],
    now: NOW,
  });
  assert.equal(one.state, 'blocked');
  assert.equal(one.reason, BACKUP_STATE_REASONS.EVIDENCE_MISSING);
});

// ---------------------------------------------------------------- [6] 聚合口径

test('[6] 聚合：四域全 completed 才 completed；一域 pending ⇒ overall pending；一域 blocked ⇒ blocked', () => {
  const allCleared = allClearedRows();
  assert.equal(deriveBackupStates({ requestId: REQUEST_ID, modules: MODULES, rows: allCleared, now: NOW }).overall, 'completed');

  const onePending = [
    ...allCleared.filter((row) => row.module !== 'history'),
    copyRow('history', { state: 'pending_purge', offsetMs: +3 * DAY, evidence: null }),
  ];
  assert.equal(
    deriveBackupStates({ requestId: REQUEST_ID, modules: MODULES, rows: onePending, now: NOW }).overall,
    'pending',
  );

  const oneBlocked = [
    ...allCleared.filter((row) => row.module !== 'history'),
    copyRow('history', { state: 'failed', evidence: null }),
  ];
  assert.equal(
    deriveBackupStates({ requestId: REQUEST_ID, modules: MODULES, rows: oneBlocked, now: NOW }).overall,
    'blocked',
  );
});

test('[6b] 必需模块闭集为空 ⇒ overall blocked（空闭集不是「全清完了」）', () => {
  const derived = deriveBackupStates({ requestId: REQUEST_ID, modules: [], rows: allClearedRows(), now: NOW });
  assert.equal(derived.overall, 'blocked');
  assert.deepEqual(derived.modules, []);
});

test('[6c] 读不到 ⇒ 四域 blocked + STORE_UNREACHABLE（⛔ 不返回 pending）', () => {
  const derived = unreadableBackupStates({ requestId: REQUEST_ID, modules: MODULES });
  assert.equal(derived.overall, 'blocked');
  assert.deepEqual(derived.missingModules, MODULES);
  for (const one of derived.modules) {
    assert.equal(one.state, 'blocked');
    assert.equal(one.reason, BACKUP_STATE_REASONS.UNREADABLE);
    assert.equal(one.errorCode, 'STORE_UNREACHABLE');
  }
});

// ---------------------------------------------------------------- [7] 只读端口

test('[7] PG 端口只 SELECT、只用已授权列、每次 derive 都重读库', async () => {
  const queries = [];
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      // 库返回的是列名蛇形的原始行；端口负责转成驼峰后再推导。
      return { rows: allClearedRows().map(toPgRow) };
    },
  };
  const port = createPostgresBackupStateReader({ client, now: () => NOW });

  assert.equal(port.kind, 'postgres');
  assert.equal(port.available, true);

  const first = await port.derive({ requestId: REQUEST_ID, userId: USER_ID, modules: MODULES });
  const second = await port.derive({ requestId: REQUEST_ID, userId: USER_ID, modules: MODULES });
  assert.equal(first.overall, 'completed');
  assert.equal(second.overall, 'completed');
  assert.equal(queries.length, 2, '不缓存结论：回执要的是当下事实');

  const sql = queries[0].text;
  assert.match(sql, /^\s*SELECT\b/i);
  for (const forbidden of [/\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bBEGIN\b/i, /\bSET\s+LOCAL\b/i]) {
    assert.ok(!forbidden.test(sql), `只读端口不得出现 ${forbidden}`);
  }
  for (const column of ['module', 'scope', 'state', 'retention_until', 'payload_digest', 'evidence_ref']) {
    assert.ok(sql.includes(column), `列 ${column} 必须在 SQL 里（且已是授权列）`);
  }
  assert.ok(!/\bpayload\b(?!_digest)/.test(sql), '⛔ 不读 payload（清除后是 null，且不在授权面）');
  assert.deepEqual(queries[0].values, [REQUEST_ID, USER_ID]);
});

test('[7b] 非 UUID 的 requestId/userId ⇒ SESSION_REQUIRED（不拼进 SQL）', async () => {
  const client = { async query() { return { rows: [] }; } };
  const port = createPostgresBackupStateReader({ client, now: () => NOW });
  await assert.rejects(
    port.derive({ requestId: "1' OR '1'='1", userId: USER_ID, modules: MODULES }),
    (error) => error.code === 'SESSION_REQUIRED',
  );
});

test('[7c] 未接线端口 available=false（memory 装配保持既有行为，不假装推导过）', async () => {
  const port = createUnwiredBackupStateReader();
  assert.equal(port.kind, 'unwired');
  assert.equal(port.available, false);
  const derived = await port.derive({ requestId: REQUEST_ID, userId: USER_ID, modules: MODULES });
  assert.equal(derived.overall, 'blocked', '未接线也不许给 completed');
});
