/**
 * GY-I19（#19）· 备份副本域**接线片**（C2）契约单测。
 *
 * 锁的是「接上之后语义不变差」这件事，而不是某个实现的内部形状：
 *   1. 纯逻辑口径（`packages/privacy/backup-copies.mjs`）：scope 闭集、payload 最小化、
 *      规范序列化、证据摘要与行数一一对应（**空集不产生证据**）；
 *   2. 真实 PG 端口的**判定表**（设计 §7.2）：到期才清、清后复核、重放不降级、
 *      无行/半清/写失败一律 `blocked`（⛔ 不写成 `pending`——那会被读成「还没轮到」）；
 *   3. 写入路径（受理事务内）的失败面：空来源 / 非法代次 / 0 对象也写一行 / 唯一键幂等；
 *   4. 端口三态是**新增可选字段**：旧 `{purged, evidenceRef}` 形状继续成立并保留旧回退语义。
 *
 * 这里**不连真库**：真库臂在 `tests/integration/backup-purge-pg.mjs`。本文件的 PG 端口用
 * 一个只认这四条 SQL 的假客户端（`user_backup_copies` 行表 + 可控失败注入），
 * 因此可以逐条断言「哪条语句在什么时候执行、参数是什么」，也不需要真集群。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_COPY_LINEAGE,
  BACKUP_COPY_SCOPES,
  assertBackupCopyModule,
  assertBackupCopyScope,
  copyPayloadDigest,
  copyPayloadJson,
  normalizeObjectRefs,
  purgeEvidenceRef,
  scopeForBackupModule,
} from '../../packages/privacy/backup-copies.mjs';
import { PrivacyError } from '../../packages/privacy/errors.mjs';
import { createPostgresBackupPurgePort, insertBackupCopySeeds } from '../../services/api/src/privacy/backup-copies-pg.ts';
import {
  CONVERSATIONS_DELETION_MODULE,
  FAVORITES_DELETION_MODULE,
  HISTORY_DELETION_MODULE,
  MESSAGES_DELETION_MODULE,
  createUnavailableBackupPurgePort,
  createUserDataDeletion,
} from '../../services/api/src/privacy/user-data-deletion.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';

/** 固定受理请求 / 主体 / 模块（全部是合法 uuid，便于断言「按 request+user+module 定位」）。 */
const REQUEST = '11111111-1111-4111-8111-111111111111';
const OTHER_REQUEST = '11111111-1111-4111-8111-222222222222';
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER_USER = '22222222-2222-4222-8222-333333333333';
const MODULE = FAVORITES_DELETION_MODULE;
const SCOPE = BACKUP_COPY_SCOPES[FAVORITES_DELETION_MODULE];

/** 固定时刻：受理 2026-10-18T00:00:00Z，备份到期 2026-11-17T00:00:00Z（30 天）。 */
const ACCEPTED_AT = '2026-10-18T00:00:00.000Z';
const BACKUP_DUE = '2026-11-17T00:00:00.000Z';
const ONE_MS_BEFORE_DUE = '2026-11-16T23:59:59.999Z';

function digestOf(refs) {
  return copyPayloadDigest(copyPayloadJson({ objectRefs: refs, records: refs.length }));
}

/** 一行副本（默认未到期、未清除）。 */
function copyRow({
  requestId = REQUEST,
  userId = USER,
  module = MODULE,
  scope = SCOPE,
  state = 'pending_purge',
  retentionUntil = BACKUP_DUE,
  refs = ['favorite-1'],
  evidenceRef = null,
} = {}) {
  return {
    request_id: requestId,
    user_id: userId,
    module,
    scope,
    state,
    retention_until: retentionUntil,
    payload: copyPayloadJson({ objectRefs: refs, records: refs.length }),
    payload_digest: digestOf(refs),
    evidence_ref: evidenceRef,
    purged_at: null,
    last_error_code: null,
    purge_attempts: 0,
  };
}

/**
 * 只认本域四条语句的假客户端。
 *
 * 支持三种故障注入：`failPurgeUpdate`（UPDATE 抛错）、`partialScopes`（只清一部分，用来
 * 触发「复核不通过」）、`connectFails`（拿不到连接）。所有经过的 SQL 都记在 `state.log` 里，
 * 便于断言「先 UPDATE 再复核」「重放不执行 UPDATE」这类顺序不变量。
 */
function createFakeBackupDb(rows) {
  const state = {
    rows: rows.map((row) => ({ ...row })),
    log: [],
    failPurgeUpdate: false,
    partialScopes: null,
    connectFails: false,
    released: 0,
  };
  const client = {
    release() {
      state.released += 1;
    },
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      state.log.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT scope, state, retention_until, payload_digest, evidence_ref')) {
        const [requestId, userId, module] = values;
        const selected = state.rows
          .filter((row) => row.request_id === requestId && row.user_id === userId && row.module === module)
          .sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0))
          .map((row) => ({
            scope: row.scope,
            state: row.state,
            retention_until: row.retention_until,
            payload_digest: row.payload_digest,
            evidence_ref: row.evidence_ref,
          }));
        return { rows: selected };
      }
      if (sql.startsWith('UPDATE public.user_backup_copies SET payload')) {
        if (state.failPurgeUpdate) throw new Error('模拟清除语句失败');
        const [requestId, userId, module, at, evidenceRef] = values;
        const touched = [];
        for (const row of state.rows) {
          if (row.request_id !== requestId || row.user_id !== userId || row.module !== module) continue;
          if (row.state !== 'pending_purge') continue;
          if (Date.parse(row.retention_until) > Date.parse(at)) continue;
          if (state.partialScopes !== null && !state.partialScopes.includes(row.scope)) continue;
          row.payload = null;
          row.state = 'purged';
          row.purged_at = at;
          row.evidence_ref = evidenceRef;
          touched.push({ scope: row.scope, payload_digest: row.payload_digest });
        }
        return { rows: touched };
      }
      if (sql.startsWith('UPDATE public.user_backup_copies SET state = ')) {
        const [requestId, userId, module, errorCode, at] = values;
        for (const row of state.rows) {
          if (row.request_id !== requestId || row.user_id !== userId || row.module !== module) continue;
          if (row.state !== 'pending_purge') continue;
          row.state = 'failed';
          row.last_error_code = errorCode;
          row.purge_attempts += 1;
          row.updated_at = at;
        }
        return { rows: [] };
      }
      throw new Error(`假客户端收到未预期的 SQL：${sql}`);
    },
  };
  const pool = {
    async connect() {
      if (state.connectFails) throw new Error('模拟连接失败');
      return client;
    },
  };
  return { pool, state };
}

function portAt(rows, nowIso) {
  const fake = createFakeBackupDb(rows);
  const port = createPostgresBackupPurgePort({ pool: fake.pool, now: () => new Date(nowIso) });
  return { port, ...fake };
}

// ---------------------------------------------------------------------------
// 1 纯逻辑：scope 闭集 + payload 最小化
// ---------------------------------------------------------------------------

test('scope 映射是闭集：有名者取词，无名者直接抛错（不猜、不截断）', () => {
  // C1b（#17 P0-2）起消息域进备份副本闭集：`messages → message`（沿用单数词形）。
  // 这条断言**扩大**而不是替换：既有两域逐字仍在，新增的第三项必须存在。
  assert.deepEqual({ ...BACKUP_COPY_SCOPES }, { favorites: 'favorite', history: 'history', messages: 'message' });
  assert.equal(scopeForBackupModule('favorites'), 'favorite');
  assert.equal(scopeForBackupModule('history'), 'history');
  assert.equal(scopeForBackupModule('messages'), 'message', '消息域必须有 scope，否则备份链看不见它');
  assert.throws(() => scopeForBackupModule('exports'), RangeError);
  assert.throws(() => scopeForBackupModule(''), RangeError);
  assert.throws(() => scopeForBackupModule(undefined), RangeError);
});

test('module/scope 形状与迁移 CHECK 同口径（小写开头、最长 32）', () => {
  assert.equal(assertBackupCopyModule('favorites'), 'favorites');
  assert.equal(assertBackupCopyScope('favorite'), 'favorite');
  for (const bad of ['Favorites', '1abc', 'a-b', '', 'a'.repeat(33)]) {
    assert.throws(() => assertBackupCopyModule(bad), RangeError, `module ${bad} 必须被拒`);
    assert.throws(() => assertBackupCopyScope(bad), RangeError, `scope ${bad} 必须被拒`);
  }
});

test('payload 只接受不透明引用与计数：自由文本/图文正文装载不进去', () => {
  const ok = normalizeObjectRefs({ objectRefs: ['a1b2', 'sha256:' + 'a'.repeat(64)], records: 2 });
  assert.deepEqual([...ok.objectRefs], ['a1b2', 'sha256:' + 'a'.repeat(64)]);
  assert.equal(ok.records, 2);
  assert.throws(() => normalizeObjectRefs({ objectRefs: ['收藏的番茄'], records: 1 }), TypeError);
  assert.throws(() => normalizeObjectRefs({ objectRefs: ['a b'], records: 1 }), TypeError);
  assert.throws(() => normalizeObjectRefs({ objectRefs: ['a'], records: 2 }), RangeError);
  assert.throws(() => normalizeObjectRefs({ objectRefs: 'a', records: 1 }), TypeError);
});

test('payload 规范序列化：空清单也合法（0 对象要能写一行），键序固定、摘要稳定', () => {
  const empty = copyPayloadJson({ objectRefs: [], records: 0 });
  assert.equal(empty, '{"object_refs":[],"records":0}');
  const one = copyPayloadJson({ objectRefs: ['x1'], records: 1 });
  assert.equal(one, '{"object_refs":["x1"],"records":1}');
  assert.match(copyPayloadDigest(one), /^[0-9a-f]{64}$/);
  assert.equal(copyPayloadDigest(one), copyPayloadDigest(copyPayloadJson({ objectRefs: ['x1'], records: 1 })));
  assert.notEqual(copyPayloadDigest(one), copyPayloadDigest(empty));
});

// ---------------------------------------------------------------------------
// 2 证据摘要：绑定 request+module+副本集合，空集不产生证据
// ---------------------------------------------------------------------------

test('证据摘要逐字可复核：同输入同值、与 digest 顺序无关、换任一维度即换证据', () => {
  const a = digestOf(['a']);
  const b = digestOf(['b']);
  const base = purgeEvidenceRef({ requestId: REQUEST, module: MODULE, payloadDigests: [a, b] });
  assert.match(base, /^sha256:[0-9a-f]{64}$/);
  assert.equal(purgeEvidenceRef({ requestId: REQUEST, module: MODULE, payloadDigests: [b, a] }), base);
  assert.notEqual(purgeEvidenceRef({ requestId: OTHER_REQUEST, module: MODULE, payloadDigests: [a, b] }), base);
  assert.notEqual(purgeEvidenceRef({ requestId: REQUEST, module: 'history', payloadDigests: [a, b] }), base);
  assert.notEqual(purgeEvidenceRef({ requestId: REQUEST, module: MODULE, payloadDigests: [a] }), base);
});

test('证据摘要拒绝空集与非法摘要（空集不得当成功）', () => {
  assert.throws(() => purgeEvidenceRef({ requestId: REQUEST, module: MODULE, payloadDigests: [] }), RangeError);
  assert.throws(() => purgeEvidenceRef({ requestId: REQUEST, module: MODULE, payloadDigests: ['A'.repeat(64)] }), TypeError);
  assert.throws(() => purgeEvidenceRef({ requestId: '', module: MODULE, payloadDigests: [digestOf(['a'])] }), TypeError);
});

// ---------------------------------------------------------------------------
// 3 受理事务内写入：0 对象也写一行、空来源拒绝、唯一键幂等
// ---------------------------------------------------------------------------

/** 记录 INSERT 的最小客户端（只认写入路径那一条 INSERT）。 */
function createInsertRecorder() {
  const state = { inserted: [], conflict: new Set() };
  const client = {
    async query(text, values = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      if (!sql.startsWith('INSERT INTO public.user_backup_copies')) {
        throw new Error(`写入路径不该执行其它 SQL：${sql}`);
      }
      const [, requestId, module, scope] = values;
      const key = `${requestId}|${module}|${scope}`;
      if (state.conflict.has(key)) return { rows: [] };
      state.conflict.add(key);
      state.inserted.push({ requestId, module, scope, values });
      return { rows: [{ id: 'generated' }] };
    },
  };
  return { client, state };
}

function seedInput(overrides = {}) {
  return {
    requestId: REQUEST,
    userId: USER,
    generation: 1,
    coveredThrough: ACCEPTED_AT,
    retentionUntil: BACKUP_DUE,
    sources: [
      {
        module: FAVORITES_DELETION_MODULE,
        scope: SCOPE,
        async snapshotOwner() {
          return { objectRefs: [], records: 0 };
        },
      },
    ],
    ...overrides,
  };
}

test('写入路径：0 个对象也写一行，payload 是空清单、摘要对得上', async () => {
  const { client, state } = createInsertRecorder();
  const inserted = await insertBackupCopySeeds(client, seedInput());
  assert.equal(inserted, 1);
  const payload = copyPayloadJson({ objectRefs: [], records: 0 });
  assert.equal(state.inserted[0].values[7], payload);
  assert.equal(state.inserted[0].values[8], copyPayloadDigest(payload));
  assert.equal(state.inserted[0].values[5], BACKUP_COPY_LINEAGE);
  assert.equal(state.inserted[0].values[9], BACKUP_DUE, 'retention_until 必须是 backup_due_at');
});

test('写入路径：来源为空/代次非法/主键非法一律拒绝（不落半套行）', async () => {
  const { client, state } = createInsertRecorder();
  await assert.rejects(() => insertBackupCopySeeds(client, seedInput({ sources: [] })), (error) => {
    assert.ok(error instanceof PrivacyError);
    assert.equal(error.code, 'STORE_REJECTED');
    return true;
  });
  await assert.rejects(() => insertBackupCopySeeds(client, seedInput({ generation: 0 })), (error) => {
    assert.equal(error.code, 'INVALID_REQUEST');
    return true;
  });
  await assert.rejects(() => insertBackupCopySeeds(client, seedInput({ userId: 'not-a-uuid' })), (error) => {
    assert.equal(error.code, 'SESSION_REQUIRED');
    return true;
  });
  assert.equal(state.inserted.length, 0, '拒绝时不得写入任何行');
});

test('写入路径幂等：同 (request, module, scope) 第二次插入被跳过（不覆盖既有证据）', async () => {
  const { client, state } = createInsertRecorder();
  assert.equal(await insertBackupCopySeeds(client, seedInput()), 1);
  assert.equal(await insertBackupCopySeeds(client, seedInput()), 0);
  assert.equal(state.inserted.length, 1);
});

test('写入路径会按主体枚举：snapshotOwner 拿到的是调用方给的 userId 与同一客户端', async () => {
  const { client } = createInsertRecorder();
  const seen = [];
  await insertBackupCopySeeds(
    client,
    seedInput({
      sources: [
        {
          module: FAVORITES_DELETION_MODULE,
          scope: SCOPE,
          async snapshotOwner(ownerId, passedClient) {
            seen.push({ ownerId, sameClient: passedClient === client });
            return { objectRefs: ['ref-1'], records: 1 };
          },
        },
      ],
    }),
  );
  assert.deepEqual(seen, [{ ownerId: USER, sameClient: true }]);
});

// ---------------------------------------------------------------------------
// 4 PG 端口判定表（设计 §7.2）
// ---------------------------------------------------------------------------

test('端口：未到期 ⇒ waiting（pending），且不执行任何清除语句', async () => {
  const { port, state } = portAt([copyRow()], ONE_MS_BEFORE_DUE);
  const result = await port.purge({ userId: USER, module: MODULE, requestId: REQUEST });
  assert.equal(result.outcome, 'waiting');
  assert.equal(result.purged, false);
  assert.ok(!state.log.some((sql) => sql.startsWith('UPDATE public.user_backup_copies SET payload')));
  assert.equal(state.rows[0].state, 'pending_purge', '未到期不得改状态');
});

test('端口：到期 ⇒ 清除 + 落证据，证据与被清行数对得上；复核在 UPDATE 之后', async () => {
  const rows = [copyRow({ scope: 'favorite', refs: ['a'] }), copyRow({ scope: 'history', refs: ['b'] })];
  const { port, state } = portAt(rows, BACKUP_DUE);
  const result = await port.purge({ userId: USER, module: MODULE, requestId: REQUEST });
  assert.equal(result.outcome, 'purged');
  assert.equal(result.purged, true);
  const expected = purgeEvidenceRef({
    requestId: REQUEST,
    module: MODULE,
    payloadDigests: rows.map((row) => row.payload_digest),
  });
  assert.equal(result.evidenceRef, expected);
  for (const row of state.rows) {
    assert.equal(row.state, 'purged');
    assert.equal(row.evidence_ref, expected);
    assert.equal(row.purged_at, BACKUP_DUE);
    assert.equal(row.payload, null, 'purged 行的 payload 必须硬删（保留行，不保留内容）');
  }
  const updateAt = state.log.findIndex((sql) => sql.startsWith('UPDATE public.user_backup_copies SET payload'));
  const reviewAt = state.log.findIndex(
    (sql, index) => index > updateAt && sql.startsWith('SELECT scope, state, retention_until'),
  );
  assert.ok(updateAt >= 0, '到期必须真的执行清除语句');
  assert.ok(reviewAt > updateAt, '完成判据必须来自删除后的复核读数');
  assert.ok(state.log.includes('COMMIT'), '复核通过后才提交');
});

test('端口重放：已 purged 再跑 ⇒ 仍 purged 且证据同值（不降级 pending、不重新清）', async () => {
  const rows = [copyRow({ state: 'purged', evidenceRef: 'sha256:' + 'e'.repeat(64), refs: ['a'] })];
  const { port, state } = portAt(rows, BACKUP_DUE);
  const result = await port.purge({ userId: USER, module: MODULE, requestId: REQUEST });
  assert.equal(result.outcome, 'purged');
  assert.equal(result.purged, true);
  assert.equal(result.evidenceRef, purgeEvidenceRef({ requestId: REQUEST, module: MODULE, payloadDigests: [rows[0].payload_digest] }));
  assert.ok(!state.log.some((sql) => sql.startsWith('UPDATE public.user_backup_copies SET payload')));
});

test('端口：没有副本行 ⇒ blocked + EVIDENCE_REQUIRED（空集不是成功）', async () => {
  const { port } = portAt([], BACKUP_DUE);
  const result = await port.purge({ userId: USER, module: MODULE, requestId: REQUEST });
  assert.equal(result.purged, false);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.errorCode, 'EVIDENCE_REQUIRED');
});

test('端口：别的请求/别的账号的行不算自己的副本（按 request+user+module 定位）', async () => {
  const { port, state } = portAt([copyRow({ requestId: OTHER_REQUEST }), copyRow({ userId: OTHER_USER })], BACKUP_DUE);
  const result = await port.purge({ userId: USER, module: MODULE, requestId: REQUEST });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.errorCode, 'EVIDENCE_REQUIRED');
  assert.equal(state.rows[0].state, 'pending_purge', '不得顺手清掉别人的行');
});

test('端口：已有 failed 行 ⇒ blocked + STORE_REJECTED（重放不自愈，需显式重排）', async () => {
  const row = copyRow();
  row.state = 'failed';
  row.last_error_code = 'STORE_UNREACHABLE';
  const { port } = portAt([row], BACKUP_DUE);
  const result = await port.purge({ userId: USER, module: MODULE, requestId: REQUEST });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.errorCode, 'STORE_REJECTED');
});

test('端口：清除后复核不通过（只清了一半）⇒ 回滚 + blocked，并把未清行如实置 failed', async () => {
  const rows = [copyRow({ scope: 'favorite' }), copyRow({ scope: 'history' })];
  const { port, state } = portAt(rows, BACKUP_DUE);
  state.partialScopes = ['favorite'];
  const result = await port.purge({ userId: USER, module: MODULE, requestId: REQUEST });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.errorCode, 'EVIDENCE_REQUIRED');
  const history = state.rows.find((row) => row.scope === 'history');
  assert.equal(history.state, 'failed');
  assert.equal(history.last_error_code, 'EVIDENCE_REQUIRED');
  assert.equal(history.purge_attempts, 1);
  assert.ok(state.log.includes('ROLLBACK'));
});

test('端口：清除语句抛错 ⇒ blocked + STORE_UNREACHABLE + 尝试次数 +1（不是 pending）', async () => {
  const { port, state } = portAt([copyRow()], BACKUP_DUE);
  state.failPurgeUpdate = true;
  const result = await port.purge({ userId: USER, module: MODULE, requestId: REQUEST });
  assert.equal(result.purged, false);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.errorCode, 'STORE_UNREACHABLE');
  assert.equal(state.rows[0].state, 'failed');
  assert.equal(state.rows[0].last_error_code, 'STORE_UNREACHABLE');
  assert.equal(state.rows[0].purge_attempts, 1);
});

test('端口：拿不到连接 ⇒ blocked + STORE_UNREACHABLE（不静默当成等待）', async () => {
  const { port, state } = portAt([copyRow()], BACKUP_DUE);
  state.connectFails = true;
  const result = await port.purge({ userId: USER, module: MODULE, requestId: REQUEST });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.errorCode, 'STORE_UNREACHABLE');
});

test('端口前置校验：非 UUID 的 userId/requestId ⇒ PrivacyError(SESSION_REQUIRED)，不查库', async () => {
  const { port, state } = portAt([copyRow()], BACKUP_DUE);
  await assert.rejects(() => port.purge({ userId: 'user-a', module: MODULE, requestId: REQUEST }), (error) => {
    assert.ok(error instanceof PrivacyError);
    assert.equal(error.code, 'SESSION_REQUIRED');
    return true;
  });
  await assert.rejects(() => port.purge({ userId: USER, module: MODULE }), (error) => {
    assert.equal(error.code, 'SESSION_REQUIRED');
    return true;
  });
  assert.equal(state.log.length, 0, '缺身份/受理上下文时不得查库');
});

// ---------------------------------------------------------------------------
// 5 接线三态：回执照实显示 completed / pending / blocked
// ---------------------------------------------------------------------------

function scriptedClock(startIso = ACCEPTED_AT) {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    advanceDays(days) {
      ms += days * 86_400_000;
    },
  };
}

async function seedMemoryStores(clock) {
  const favoritesStore = createMemoryFavoritesStore({ now: () => clock.now().getTime() });
  const historyStore = createMemoryHistoryStore({ now: () => clock.now().getTime() });
  // #17 消息域（C1b 起进闭集）：三态接线用例必须给消息域同样一份真 store，
  // 否则该模块会因「装配漏给 store」被折叠成 blocked，把三态断言的读数搅浑。
  const messagesStore = createMemoryMessagesStore({ now: () => clock.now().getTime() });
  // #12 会话域（C1b-3 起进闭集）：同样给一份真 store，否则该模块会被折叠成 blocked。
  const conversationsStore = createMemoryConversationStore();
  await favoritesStore.insertFavorite({
    id: '00000000-0000-4000-8100-000000000001',
    revision: 1,
    owner_id: USER,
    target_ref: { type: 'species', id: 'spc-1', revision: 1 },
    created_at: clock.now().toISOString(),
  });
  await messagesStore.insertMessage({
    id: '00000000-0000-4000-8100-000000000002',
    revision: 1,
    owner_id: USER,
    type: 'system',
    target_ref: null,
    read_at: null,
    created_at: clock.now().toISOString(),
    event_key: 'msg-port-contract',
  });
  return { favoritesStore, historyStore, messagesStore, conversationsStore };
}

async function driveWith(port) {
  const clock = scriptedClock();
  const stores = await seedMemoryStores(clock);
  const deletion = createUserDataDeletion({
    favoritesStore: stores.favoritesStore,
    historyStore: stores.historyStore,
    messagesStore: stores.messagesStore,
    conversationsStore: stores.conversationsStore,
    backupPurge: port,
    now: clock.now,
  });
  const request = deletion.requestDeletionFor(USER);
  await deletion.executeHandlers(request.id);
  const receipt = deletion.receipt(request.id);
  const byModule = new Map(receipt['handlers'].map((row) => [row['module'], row]));
  return { receipt, byModule };
}

test('接线三态：端口说 blocked ⇒ 该模块 backup_state=blocked 且带原因码（⛔ 不是 pending）', async () => {
  const { byModule } = await driveWith({
    kind: 'wired',
    available: true,
    async purge() {
      return { purged: false, outcome: 'blocked', errorCode: 'EVIDENCE_REQUIRED', reason: '无副本行' };
    },
  });
  for (const module of [
    FAVORITES_DELETION_MODULE,
    HISTORY_DELETION_MODULE,
    MESSAGES_DELETION_MODULE,
    CONVERSATIONS_DELETION_MODULE,
  ]) {
    assert.equal(byModule.get(module).backup_state, 'blocked');
    assert.equal(byModule.get(module).error_code, 'EVIDENCE_REQUIRED');
  }
});

test('接线三态：端口说 waiting ⇒ 该模块 pending（还没轮到，不算失败）', async () => {
  const { byModule } = await driveWith({
    kind: 'wired',
    available: true,
    async purge() {
      return { purged: false, outcome: 'waiting', reason: 'BACKUP_WAITING_RETENTION' };
    },
  });
  assert.equal(byModule.get(FAVORITES_DELETION_MODULE).backup_state, 'pending');
  assert.equal(byModule.get(FAVORITES_DELETION_MODULE).error_code, null);
});

test('接线三态：端口说 purged 且有证据 ⇒ completed；说 purged 但没证据 ⇒ blocked（不谎称完成）', async () => {
  const evidenceRef = 'sha256:' + 'c'.repeat(64);
  const completed = await driveWith({
    kind: 'wired',
    available: true,
    async purge() {
      return { purged: true, outcome: 'purged', evidenceRef };
    },
  });
  assert.equal(completed.byModule.get(FAVORITES_DELETION_MODULE).backup_state, 'completed');
  assert.equal(completed.byModule.get(FAVORITES_DELETION_MODULE).error_code, null);

  const unproven = await driveWith({
    kind: 'wired',
    available: true,
    async purge() {
      return { purged: true, outcome: 'purged' };
    },
  });
  assert.equal(unproven.byModule.get(FAVORITES_DELETION_MODULE).backup_state, 'blocked');
  assert.equal(unproven.byModule.get(FAVORITES_DELETION_MODULE).error_code, 'EVIDENCE_REQUIRED');
});

test('旧形状兼容：不给 outcome 的端口按老语义回退（有证据 completed，否则 pending）', async () => {
  const legacy = await driveWith({
    kind: 'wired',
    available: true,
    async purge() {
      return { purged: true, evidenceRef: 'legacy-evidence' };
    },
  });
  assert.equal(legacy.byModule.get(FAVORITES_DELETION_MODULE).backup_state, 'completed');

  const legacyNoEvidence = await driveWith({
    kind: 'wired',
    available: true,
    async purge() {
      return { purged: true };
    },
  });
  assert.equal(legacyNoEvidence.byModule.get(FAVORITES_DELETION_MODULE).backup_state, 'pending');
});

test('不可用端口（real 模式无真库）⇒ 抛 PROVIDER_UNAVAILABLE，回执折叠为 blocked', async () => {
  const port = createUnavailableBackupPurgePort();
  assert.equal(port.available, true);
  await assert.rejects(() => port.purge({ userId: USER, module: MODULE, onlineRemoved: 0 }), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    return true;
  });
  const { byModule } = await driveWith(port);
  assert.equal(byModule.get(FAVORITES_DELETION_MODULE).backup_state, 'blocked');
  assert.equal(byModule.get(FAVORITES_DELETION_MODULE).error_code, 'PROVIDER_UNAVAILABLE');
});

test('内存 store 的 snapshotOwner 只回不透明 id 与计数（0 对象也能枚举）', async () => {
  const clock = scriptedClock();
  const stores = await seedMemoryStores(clock);
  const favorites = await stores.favoritesStore.snapshotOwner(USER, { query: async () => ({ rows: [] }) });
  assert.equal(favorites.records, 1);
  assert.deepEqual([...favorites.objectRefs], ['00000000-0000-4000-8100-000000000001']);
  const history = await stores.historyStore.snapshotOwner(USER, { query: async () => ({ rows: [] }) });
  assert.deepEqual({ refs: [...history.objectRefs], records: history.records }, { refs: [], records: 0 });
});
