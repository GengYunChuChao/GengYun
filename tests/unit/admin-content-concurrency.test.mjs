/**
 * GY-I18 阶段 1 · 幂等并发 + 审计不可改删。
 *
 * 这一组是派单第 2 节第 4/7 条的证据：
 * - 发布/撤回先**原子占位**；同键同体并发 ⇒ 恰好 1 次生效 + 恰好 1 条审计；
 * - 同键异体 ⇒ IDEMPOTENCY_CONFLICT；重复 publish/withdraw 幂等；失败释放占位；
 * - 审计台账只能追加，任何改/删尝试都必须失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  idempotencyKeyHashHex,
  idempotencyRequestHash,
  idempotencyScope,
} from '../../services/api/src/auth/idempotency.ts';
import { auditLogSurface } from '../../services/api/src/admin/audit.ts';
import {
  FAMILY_CASES,
  SIGNING_KEY,
  STEWARD,
  context,
  createDraft,
  createHarness,
  expectApiError,
  idempotencyKey,
  publishRevision,
  validPublishBody,
  validSourceInput,
  validWithdrawBody,
} from './admin-fixtures.mjs';

const SOURCES = FAMILY_CASES[0];
const KNOWLEDGE = FAMILY_CASES[1];

/** 读审计（契约口径）与内部记录（含主体）。 */
async function auditItems(service) {
  return (await service.listAuditEvents(context())).body.data.items;
}

test('并发同键同体发布：恰好 1 次生效 + 恰好 1 条审计（四类资料各一次）', async () => {
  for (const caseEntry of FAMILY_CASES) {
    const { service, store, view } = createHarness();
    const created = await createDraft(caseEntry, service);
    const id = created.body.data.id;
    const ops = caseEntry.ops(service);
    const key = idempotencyKey(`${caseEntry.name}-race`);
    const body = validPublishBody();
    const ctx = { ...context(), idempotencyKey: key, ifMatch: '"1"' };
    // 建草稿本身也占一行幂等台账，故以建草稿之后的基线计数。
    const baseline = store.idempotentCount();

    const results = await Promise.all([
      ops.publish(ctx, id, body),
      ops.publish(ctx, id, body),
      ops.publish(ctx, id, body),
    ]);
    for (const result of results) {
      assert.equal(typeof result.status, 'number');
      assert.equal(result.status, 200);
      assert.deepStrictEqual(result.body, results[0].body, '同键同体并发必须收敛到同一结果');
    }
    const entity = store.getEntity(id);
    assert.equal(entity.revisions.length, 1, '不得产生额外修订');
    assert.equal(entity.publishedRevision, 1);
    assert.equal(entity.lifecycle, 'published');
    const events = await auditItems(service);
    assert.equal(events.length, 1, `${caseEntry.name} 并发发布后审计必须恰好一条`);
    assert.equal(events[0].result, 'accepted');
    assert.equal(events[0].target_ref.revision, 1);
    assert.notEqual(view.readPublished(caseEntry.descriptor.family, id), null);
    // 台账只多一行：重放不新增行。
    assert.equal(store.idempotentCount(), baseline + 1);
  }
});

test('并发 20 路同键同体发布：恰好 1 次生效 + 1 条审计', async () => {
  const { service, store } = createHarness();
  const created = await createDraft(SOURCES, service);
  const id = created.body.data.id;
  const ops = SOURCES.ops(service);
  const ctx = { ...context(), idempotencyKey: idempotencyKey('storm'), ifMatch: '"1"' };
  const body = validPublishBody();
  const baseline = store.idempotentCount();

  const results = await Promise.all(Array.from({ length: 20 }, () => ops.publish(ctx, id, body)));
  assert.equal(results.length, 20);
  for (const result of results) assert.equal(result.status, 200);
  assert.equal((await auditItems(service)).length, 1);
  assert.equal(store.getEntity(id).revisions.length, 1);
  assert.equal(store.idempotentCount(), baseline + 1);
});

test('同键异体：并发发布不同发布体 ⇒ IDEMPOTENCY_CONFLICT', async () => {
  const { service, store } = createHarness();
  const created = await createDraft(SOURCES, service);
  const id = created.body.data.id;
  const ops = SOURCES.ops(service);
  const key = idempotencyKey('conflict');

  const settled = await Promise.allSettled([
    ops.publish({ ...context(), idempotencyKey: key, ifMatch: '"1"' }, id, validPublishBody({ reason: '第一种理由' })),
    ops.publish({ ...context(), idempotencyKey: key, ifMatch: '"1"' }, id, validPublishBody({ reason: '第二种理由' })),
  ]);
  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
  const rejected = settled.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1, '同键异体只能有一次生效');
  assert.equal(rejected.length, 1);
  assert.equal(typeof rejected[0].reason.code, 'string');
  assert.equal(rejected[0].reason.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(rejected[0].reason.status, 409);
  assert.equal((await auditItems(service)).length, 1);
  assert.equal(store.getEntity(id).lifecycle, 'published');
});

test('同键异体（建草稿）：第二个不同请求体被拒', async () => {
  const { service, store } = createHarness();
  const key = idempotencyKey('create-conflict');
  const ops = SOURCES.ops(service);
  const first = await ops.create({ ...context(), idempotencyKey: key }, validSourceInput());
  assert.equal(first.status, 201);
  await expectApiError(
    () => ops.create({ ...context(), idempotencyKey: key }, validSourceInput({ title: '另一个标题' })),
    'IDEMPOTENCY_CONFLICT',
  );
  // 同键同体重放：返回同一条，不新建。
  const replay = await ops.create({ ...context(), idempotencyKey: key }, validSourceInput());
  assert.deepStrictEqual(replay.body, first.body);
  assert.equal(store.idempotentCount(), 1);
  assert.equal((await service.listAdminSources(context())).body.data.items.length, 1);
});

test('同键同体重放：逐字相同的响应，且不产生第二次状态迁移', async () => {
  for (const caseEntry of FAMILY_CASES) {
    const { service, view } = createHarness();
    const created = await createDraft(caseEntry, service);
    const id = created.body.data.id;
    const ops = caseEntry.ops(service);
    const key = idempotencyKey(`${caseEntry.name}-replay`);
    const publishCtx = { ...context(), idempotencyKey: key, ifMatch: '"1"' };

    const first = await ops.publish(publishCtx, id, validPublishBody());
    const replay = await ops.publish(publishCtx, id, validPublishBody());
    assert.deepStrictEqual(replay.body, first.body);
    assert.deepStrictEqual(replay.headers, first.headers);
    assert.equal(replay.status, first.status);
    assert.equal((await auditItems(service)).length, 1, '重放不得追加审计');

    // 撤回同样：同键重放只记一条。
    const withdrawKey = idempotencyKey(`${caseEntry.name}-replay-w`);
    const withdrawCtx = { ...context(), idempotencyKey: withdrawKey, ifMatch: '"1"' };
    const firstWithdraw = await ops.withdraw(withdrawCtx, id, validWithdrawBody());
    const replayWithdraw = await ops.withdraw(withdrawCtx, id, validWithdrawBody());
    assert.deepStrictEqual(replayWithdraw.body, firstWithdraw.body);
    assert.equal((await auditItems(service)).length, 2);
    assert.equal(view.readPublished(caseEntry.descriptor.family, id), null);
  }
});

test('异键并发发布：第二次是幂等空操作，不产生第二次迁移或第二条审计', async () => {
  const { service, store } = createHarness();
  const created = await createDraft(SOURCES, service);
  const id = created.body.data.id;
  const ops = SOURCES.ops(service);
  const baseline = store.idempotentCount();

  const results = await Promise.all([
    ops.publish({ ...context(), idempotencyKey: idempotencyKey('a'), ifMatch: '"1"' }, id, validPublishBody()),
    ops.publish({ ...context(), idempotencyKey: idempotencyKey('b'), ifMatch: '"1"' }, id, validPublishBody()),
  ]);
  for (const result of results) assert.equal(result.status, 200);
  const entity = store.getEntity(id);
  assert.equal(entity.publishedRevision, 1);
  assert.equal(entity.revisions.length, 1);
  assert.equal((await auditItems(service)).length, 1, '异键并发只允许一条发布审计');
  assert.equal(store.idempotentCount(), baseline + 2, '两个键各自占一行');
});

test('失败释放占位：失败后可以用同一个键重试成功', async () => {
  const { service, store, clock } = createHarness();
  const authorId = context().identity.userId;

  // ---- A) 发布门槛失败（库中内容不合契约）⇒ 占位必须释放 ----
  // 既有修订在存储边界已被深冻结（返修 1），故用「追加一条不合契约的修订」注入非法内容。
  const a = await createDraft(SOURCES, service);
  const idA = a.body.data.id;
  const entityA = store.getEntity(idA);
  const before = structuredClone(entityA.revisions[0].content);
  store.appendRevision({
    entity: entityA,
    content: { ...before, title: '' },
    authorId,
    createdAt: clock.now(),
    derivedFromRevision: 1,
  });
  const key = idempotencyKey('release');
  const scopeA = idempotencyScope(STEWARD, 'POST', `/admin/sources/${idA}/publish`);
  await expectApiError(
    () => service.publishSource({ ...context(), idempotencyKey: key, ifMatch: '"2"' }, idA, validPublishBody()),
    'INVALID_REQUEST',
  );
  assert.equal(store.peekIdempotent(scopeA, idempotencyKeyHashHex(scopeA, key)), null, '失败后占位必须被释放');

  // 追加合法修订后用**同一个键**重试 ⇒ 成功，证明占位确实释放了。
  store.appendRevision({
    entity: entityA,
    content: before,
    authorId,
    createdAt: clock.now(),
    derivedFromRevision: 2,
  });
  const retried = await service.publishSource({ ...context(), idempotencyKey: key, ifMatch: '"3"' }, idA, validPublishBody());
  assert.equal(retried.status, 200);
  assert.equal(store.getEntity(idA).lifecycle, 'published');

  // ---- B) If-Match 不匹配导致失败后，同样的键也能重试 ----
  const b = await createDraft(SOURCES, service);
  const idB = b.body.data.id;
  const editKey = idempotencyKey('release-edit');
  await expectApiError(
    () => service.editSourceDraft({ ...context(), idempotencyKey: editKey, ifMatch: '"9"' }, idB, SOURCES.editedInput()),
    'REVISION_CONFLICT',
  );
  const edited = await service.editSourceDraft({ ...context(), idempotencyKey: editKey, ifMatch: '"1"' }, idB, SOURCES.editedInput());
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.revision, 2);
});

test('占位未定型时的同键请求 ⇒ REQUEST_IN_PROGRESS（可重试）；同键异体 ⇒ IDEMPOTENCY_CONFLICT', async () => {
  const { service, store, clock } = createHarness();
  const created = await createDraft(SOURCES, service);
  const id = created.body.data.id;
  const key = idempotencyKey('inflight');
  const path = `/admin/sources/${id}/publish`;
  const scope = idempotencyScope(STEWARD, 'POST', path);
  const keyHash = idempotencyKeyHashHex(scope, key);
  const body = validPublishBody();

  // 模拟「占位者中途夭折」：直接写入一条未定型的占位行（outcome === null）。
  const claimed = store.claimIdempotent(scope, keyHash, {
    requestHash: idempotencyRequestHash(body, '"1"', SIGNING_KEY),
    responseStatus: 200,
    expiresAt: new Date(clock.peek().getTime() + 60_000),
    now: clock.now(),
  });
  assert.equal(claimed, true);

  const inflight = await expectApiError(
    () => service.publishSource({ ...context(), idempotencyKey: key, ifMatch: '"1"' }, id, body),
    'REQUEST_IN_PROGRESS',
  );
  assert.equal(inflight.status, 409);
  assert.equal(inflight.retryable, true);
  assert.equal(store.getEntity(id).lifecycle, 'draft', '占位中不得发生状态迁移');
  assert.equal((await auditItems(service)).length, 0);

  const conflicting = await expectApiError(
    () => service.publishSource({ ...context(), idempotencyKey: key, ifMatch: '"1"' }, id, validPublishBody({ reason: '另一种理由' })),
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(conflicting.status, 409);
});

test('占位/结果到期后可被清理，过期键不再永久占用', async () => {
  const { service, store, clock } = createHarness();
  const created = await createDraft(SOURCES, service);
  const id = created.body.data.id;
  const key = idempotencyKey('ttl');
  await service.publishSource({ ...context(), idempotencyKey: key, ifMatch: '"1"' }, id, validPublishBody());
  // 建草稿与发布各占一行。
  const before = store.idempotentCount();
  assert.equal(before, 2);
  // 默认普通回执保留 24 小时；在最后受理时刻之后越过该窗口。
  const removed = store.purgeExpiredIdempotent(new Date(clock.peek().getTime() + 24 * 60 * 60 * 1000));
  assert.equal(removed, before);
  assert.equal(store.idempotentCount(), 0);
});

test('审计台账只能追加：没有改删入口，记录深冻结，返回的是副本', async () => {
  const { service, store } = createHarness();
  const created = await createDraft(KNOWLEDGE, service);
  const id = created.body.data.id;
  await publishRevision(KNOWLEDGE, service, id, 1);

  const log = store.audit;
  // 1) 对外表面恰好是这三个方法；任何 update/delete/remove/clear/truncate 都不存在。
  assert.deepStrictEqual(Object.keys(log).sort(), [...auditLogSurface].sort());
  assert.deepStrictEqual(Object.keys(log).sort(), ['append', 'count', 'list']);
  for (const forbidden of ['update', 'delete', 'remove', 'clear', 'truncate', 'set', 'splice', 'pop', 'shift', 'put']) {
    assert.equal(log[forbidden], undefined, `审计台账不得暴露 ${forbidden}`);
  }

  // 2) 记录与 target_ref 深冻结：任何赋值都抛错（ESM 严格模式下发往冻结对象即 TypeError）。
  const record = log.list()[0];
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.target_ref), true);
  assert.throws(() => {
    record.action = 'tampered';
  }, TypeError);
  assert.throws(() => {
    record.target_ref.revision = 999;
  }, TypeError);
  assert.throws(() => {
    record.result = 'failed';
  }, TypeError);

  // 3) list() 每次返回新的冻结数组；往里塞东西动不了台账。
  const first = log.list();
  const second = log.list();
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => {
    first.push({});
  }, TypeError);
  assert.throws(() => {
    first.length = 0;
  }, TypeError);
  assert.equal(log.count(), 1);
  assert.equal(log.list().length, 1);

  // 4) 契约出口给的是副本：改它不影响台账，也不影响下一次读。
  const items = await auditItems(service);
  const before = JSON.stringify(items);
  items[0].action = 'tampered';
  items[0].target_ref.revision = 999;
  items.length = 0;
  const after = JSON.stringify(await auditItems(service));
  assert.equal(after, before, '契约出口必须返回副本，改不动审计台账');
  assert.equal(log.count(), 1);

  // 5) 内部记录带有主体（契约 AuditEvent 没有 actor 字段，这是缺口），
  //    而契约投影严格只有合同的 8 个字段。
  const internal = log.list()[0];
  assert.equal(typeof internal.actor_id, 'string');
  assert.equal(internal.actor_id, STEWARD);
  const projected = (await auditItems(service))[0];
  assert.equal(Object.hasOwn(projected, 'actor_id'), false);
  assert.deepStrictEqual(
    Object.keys(projected).sort(),
    ['action', 'created_at', 'id', 'reason_code', 'request_id', 'result', 'scope', 'target_ref'],
  );
});

test('审计事件逐次追加且目标 revision 精确，绝不因撤回或覆盖而消失', async () => {
  const { service, store } = createHarness();
  const created = await createDraft(SOURCES, service);
  const id = created.body.data.id;
  await publishRevision(SOURCES, service, id, 1);
  await service.editSourceDraft({ ...context(), idempotencyKey: idempotencyKey('e'), ifMatch: '"1"' }, id, SOURCES.editedInput());
  await publishRevision(SOURCES, service, id, 2);
  await service.withdrawSource({ ...context(), idempotencyKey: idempotencyKey('w'), ifMatch: '"2"' }, id, validWithdrawBody());

  const events = await auditItems(service);
  assert.deepStrictEqual(
    events.map((event) => `${event.action}@${event.target_ref.revision}`),
    ['source.publish@1', 'source.edit@2', 'source.publish@2', 'source.withdraw@2'],
  );
  assert.equal(store.audit.count(), 4);
  // 撤回后审计仍在（撤回不删审计痕迹）。
  assert.equal(events.length, 4);
  // 本片新增：**关键修改（版本/来源）必须留责任人与范围** —— `source.edit` 事件带主体、
  // 行使的 scope，以及内部"影响范围"字段（引用条数/失效条数）；契约投影不输出该内部字段。
  const editEvent = store.audit.list().find((record) => record.action === 'source.edit');
  assert.equal(typeof editEvent, 'object', '编辑必须留审计');
  assert.equal(editEvent.actor_id, STEWARD);
  assert.equal(editEvent.scope, 'sources:write');
  assert.equal(editEvent.result, 'accepted');
  assert.match(editEvent.target_hint, /^source:.+:rev=2:live=.+:refs=\d+:invalidated=\d+$/);
  assert.equal(Object.hasOwn(events[1], 'target_hint'), false, '内部 target_hint 不得出现在契约投影里');
  // 每个事件都有主体（内部记录）与 request_id。
  for (const record of store.audit.list()) {
    assert.equal(typeof record.actor_id, 'string');
    assert.equal(typeof record.request_id, 'string');
    assert.equal(typeof record.created_at, 'string');
  }
});
