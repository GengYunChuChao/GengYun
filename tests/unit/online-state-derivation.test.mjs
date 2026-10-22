/**
 * GY-R32 · #19 片B · **回执在线态由真实证据推导**（纯函数 + 只读端口的内存臂）。
 *
 * 三条硬判据（对应派单 §2「回执可推导」）：
 *   ① 到期清完（四域各有可复算证据）⇒ 每域 `completed`、聚合 `completed`；
 *   ② 未到期 ⇒ `pending`（唯一正当的 pending 语义：还没轮到）；
 *   ③ 到期未清（没有证据）⇒ `blocked` + `STORE_REJECTED`，⛔ **绝不得**判 `pending`。
 *
 * 反向控制（不是恒绿）：
 *   - 证据摘要对不上 / 形状非法 / 缺域 ⇒ `blocked`（⛔ 不降级成 pending，也不抬成 completed）；
 *   - 读不到（连接/权限/形状）⇒ 四域全 blocked + `STORE_UNREACHABLE`；
 *   - 两个互不共享内存的读端口（模拟换新进程）读同一份落库证据，结论必须一致。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { onlinePurgeEvidenceRef } from '../../services/api/src/privacy/online-purge-driver.ts';
import {
  ONLINE_STATE_REASONS,
  createPostgresOnlineStateReader,
  deriveOnlineStates,
  unreadableOnlineStates,
} from '../../services/api/src/privacy/online-state-derivation.ts';
import { USER_DATA_DELETION_MODULES } from '../../services/api/src/privacy/user-data-deletion.ts';

const REQUEST = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const DAY = 24 * 60 * 60 * 1000;
const DUE = '2026-04-01T00:00:00.000Z';
const BEFORE_DUE = new Date(Date.parse(DUE) - DAY);
const AFTER_DUE = new Date(Date.parse(DUE) + DAY);

/** 一条与生产同形的证据（**纯推导行**口径：读函数转驼峰后的元素）。 */
function entry(module, { removed = 1, idempotency = 0, requestId = REQUEST } = {}) {
  return {
    module,
    evidenceRef: onlinePurgeEvidenceRef({ requestId, module, removed, idempotency }),
    removed,
    idempotency,
    purgedAt: '2026-03-30T12:00:00.000Z',
  };
}

/** 同一条证据在**库函数 jsonb** 里的原始形状（snake_case）——只用于读端口的入参。 */
function dbEntry(module, options = {}) {
  const one = entry(module, options);
  return {
    module: one.module,
    evidence_ref: one.evidenceRef,
    removed: one.removed,
    idempotency: one.idempotency,
    purged_at: one.purgedAt,
  };
}

function row({ evidence = null, due = DUE, requestState = 'processing' } = {}) {
  return {
    requestId: REQUEST,
    requestState,
    onlineDueAt: due,
    evidence: evidence ?? USER_DATA_DELETION_MODULES.map((module) => entry(module)),
  };
}

function derive(input = {}) {
  return deriveOnlineStates({
    requestId: REQUEST,
    modules: [...USER_DATA_DELETION_MODULES],
    row: input.row ?? row(),
    now: input.now ?? AFTER_DUE,
  });
}

test('在线态/①：到期且四域证据可复算 ⇒ 四域 completed、聚合 completed', () => {
  const derived = derive();
  assert.equal(derived.overall, 'completed');
  assert.deepEqual(derived.missingModules, []);
  for (const module of USER_DATA_DELETION_MODULES) {
    const one = derived.modules.find((item) => item.module === module);
    assert.equal(one.state, 'completed', `${module} 必须 completed`);
    assert.equal(one.reason, ONLINE_STATE_REASONS.PURGED_WITH_EVIDENCE);
    assert.equal(one.errorCode, null);
    assert.equal(
      one.evidenceRef,
      onlinePurgeEvidenceRef({ requestId: REQUEST, module, removed: 1, idempotency: 0 }),
      `${module} 的证据摘要必须与落库读数逐字相等（可复算）`,
    );
  }
});

test('在线态/②：未到期且没有证据 ⇒ pending（不是 blocked）', () => {
  const derived = derive({ row: row({ evidence: [] }), now: BEFORE_DUE });
  assert.equal(derived.overall, 'pending');
  for (const one of derived.modules) {
    assert.equal(one.state, 'pending');
    assert.equal(one.reason, ONLINE_STATE_REASONS.NOT_DUE);
    assert.equal(one.errorCode, null);
  }
});

test('在线态/③：到期但没有任何证据 ⇒ blocked + STORE_REJECTED（⛔ 不得 pending）', () => {
  const derived = derive({ row: row({ evidence: [] }), now: AFTER_DUE });
  assert.equal(derived.overall, 'blocked');
  for (const one of derived.modules) {
    assert.equal(one.state, 'blocked', `${one.module} 到期未清必须 blocked`);
    assert.equal(one.reason, ONLINE_STATE_REASONS.DUE_NOT_EXECUTED);
    assert.equal(one.errorCode, 'STORE_REJECTED');
  }
});

test('在线态/③b：到期但只清了一部分 ⇒ 缺证据的域 blocked、其余 completed，聚合 blocked', () => {
  const partial = [entry('favorites'), entry('history')];
  const derived = derive({ row: row({ evidence: partial }), now: AFTER_DUE });
  assert.equal(derived.overall, 'blocked');
  assert.deepEqual([...derived.missingModules].sort(), ['conversations', 'messages']);
  assert.equal(derived.modules.find((one) => one.module === 'favorites').state, 'completed');
  const missing = derived.modules.find((one) => one.module === 'messages');
  assert.equal(missing.state, 'blocked');
  assert.equal(missing.errorCode, 'STORE_REJECTED');
});

test('在线态/④：到期前就已清（受理时处理器清完）也判 completed —— 未到期 ≠ 未清', () => {
  const derived = derive({ now: BEFORE_DUE });
  assert.equal(derived.overall, 'completed', '有可复算证据 ⇒ 即使未到期也必须 completed');
});

test('在线态/⑤：证据摘要与读数对不上 ⇒ blocked + EVIDENCE_REQUIRED（不抬成 completed）', () => {
  const forged = USER_DATA_DELETION_MODULES.map((module) => entry(module));
  forged[1] = { ...forged[1], removed: 9 }; // 读数被改，摘要不再是这个读数的摘要
  const derived = derive({ row: row({ evidence: forged }) });
  assert.equal(derived.overall, 'blocked');
  const one = derived.modules.find((item) => item.module === forged[1].module);
  assert.equal(one.state, 'blocked');
  assert.equal(one.reason, ONLINE_STATE_REASONS.EVIDENCE_MISMATCH);
  assert.equal(one.errorCode, 'EVIDENCE_REQUIRED');
});

test('在线态/⑥：证据形状非法（缺字段/负数/非数组）⇒ blocked + POLICY_BLOCKED，不猜', () => {
  const cases = [
    { evidence: [{ module: 'favorites', removed: 1, idempotency: 0 }], poisoned: 'favorites' }, // 缺 evidenceRef
    { evidence: [{ ...entry('history'), removed: -1 }], poisoned: 'history' }, // 负数
    { evidence: { not: 'an array' }, poisoned: null }, // 顶层不是数组 ⇒ 四域都不可判
  ];
  for (const { evidence, poisoned } of cases) {
    const derived = derive({ row: row({ evidence }) });
    assert.equal(derived.overall, 'blocked', `形状非法必须 blocked：${JSON.stringify(evidence)}`);
    const target = poisoned === null ? derived.modules : derived.modules.filter((one) => one.module === poisoned);
    assert.ok(target.length > 0);
    assert.ok(
      target.every((one) => one.state === 'blocked' && one.errorCode === 'POLICY_BLOCKED'),
      `形状非法的那一域必须恰好 POLICY_BLOCKED（现场 ${JSON.stringify(target)}）`,
    );
  }
});

test('在线态/⑦：闭集里的域一行证据都没有 ⇒ 该域 blocked（只清两域永远到不了 completed）', () => {
  const derived = deriveOnlineStates({
    requestId: REQUEST,
    modules: [...USER_DATA_DELETION_MODULES, 'community'],
    row: row(),
    now: AFTER_DUE,
  });
  assert.equal(derived.overall, 'blocked');
  assert.deepEqual([...derived.missingModules], ['community']);
});

test('在线态/⑧：读不到 ⇒ 四域全 blocked + STORE_UNREACHABLE（⛔ 不返回 pending）', () => {
  const derived = unreadableOnlineStates({ requestId: REQUEST, modules: [...USER_DATA_DELETION_MODULES] });
  assert.equal(derived.overall, 'blocked');
  for (const one of derived.modules) {
    assert.equal(one.state, 'blocked');
    assert.equal(one.errorCode, 'STORE_UNREACHABLE');
    assert.equal(one.reason, ONLINE_STATE_REASONS.UNREADABLE);
  }
});

test('在线态/⑨：只读端口解析库函数返回值；请求不存在 ⇒ 抛 NOT_FOUND（由调用方折叠 blocked）', async () => {
  const payload = {
    request_id: REQUEST,
    state: 'processing',
    online_due_at: DUE,
    online_purged_at: '2026-03-30T12:00:00.000Z',
    evidence: USER_DATA_DELETION_MODULES.map((module) => dbEntry(module)),
  };
  const reader = createPostgresOnlineStateReader({
    client: { async query() { return { rows: [{ state: payload }] }; } },
    now: () => AFTER_DUE,
  });
  const derived = await reader.derive({ requestId: REQUEST, userId: USER, modules: [...USER_DATA_DELETION_MODULES] });
  assert.equal(derived.overall, 'completed');

  const missing = createPostgresOnlineStateReader({
    client: { async query() { return { rows: [{ state: null }] }; } },
    now: () => AFTER_DUE,
  });
  await assert.rejects(
    () => missing.derive({ requestId: REQUEST, userId: USER, modules: [...USER_DATA_DELETION_MODULES] }),
    (error) => error.code === 'NOT_FOUND',
    '读不到行必须抛 NOT_FOUND，由调用方折叠成 blocked（不静默返回 pending）',
  );
});

test('在线态/⑩：换一个读端口（不共享任何内存）读同一份落库证据 ⇒ 结论一致（新进程可读）', async () => {
  const payload = {
    request_id: REQUEST,
    state: 'processing',
    online_due_at: DUE,
    online_purged_at: '2026-03-30T12:00:00.000Z',
    evidence: USER_DATA_DELETION_MODULES.map((module) => dbEntry(module)),
  };
  const makeReader = () =>
    createPostgresOnlineStateReader({
      // 每个 reader 各自一条「连接」：不共享缓存/上次结论。
      client: { async query() { return { rows: [{ state: JSON.parse(JSON.stringify(payload)) }] }; } },
      now: () => AFTER_DUE,
    });
  const first = await makeReader().derive({ requestId: REQUEST, userId: USER, modules: [...USER_DATA_DELETION_MODULES] });
  const second = await makeReader().derive({ requestId: REQUEST, userId: USER, modules: [...USER_DATA_DELETION_MODULES] });
  assert.deepEqual(first, second);
  assert.equal(second.overall, 'completed');
});

test('在线态/⑪：端口必须校验 UUID（不把任意字符串拼进 SQL 参数语义）', async () => {
  const reader = createPostgresOnlineStateReader({
    client: { async query() { return { rows: [] }; } },
    now: () => AFTER_DUE,
  });
  await assert.rejects(
    () => reader.derive({ requestId: 'not-a-uuid', userId: USER, modules: [...USER_DATA_DELETION_MODULES] }),
    (error) => error.code === 'SESSION_REQUIRED',
  );
  await assert.rejects(
    () => reader.derive({ requestId: REQUEST, userId: 'nope', modules: [...USER_DATA_DELETION_MODULES] }),
    (error) => error.code === 'SESSION_REQUIRED',
  );
});
