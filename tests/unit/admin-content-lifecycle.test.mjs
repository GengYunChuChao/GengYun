/**
 * GY-I18 阶段 1 · 生命周期正控制。
 *
 * 断言的是派单第 2 节的「正向可达」部分，而且**四类资料跑同一段脚本**：
 * 这既是正控制，也是「四类共用一套代码」的直接证据（差异只允许出现在
 * 已记录的那 4 处：inputSchema / 出参形状 / 是否有 visibility / TargetRef 映射）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILY_CASES,
  assertMatchesContract,
  context,
  createDraft,
  createHarness,
  editRevision,
  expectApiError,
  publishRevision,
  withdrawRevision,
} from './admin-fixtures.mjs';

/** 把对象里第一个字符串字段改掉，用来证明「库里存的是副本，不是调用方的引用」。 */
function tamperFirstString(value) {
  if (typeof value !== 'object' || value === null) return false;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') {
      value[key] = `${child}-TAMPERED`;
      return true;
    }
    if (tamperFirstString(child)) return true;
  }
  return false;
}

test('正控制：四类资料 create → publish → 公开可见 → withdraw → 不可见，审计仍在', async () => {
  const observed = [];
  for (const caseEntry of FAMILY_CASES) {
    const { service, view, store } = createHarness();
    const ops = caseEntry.ops(service);
    const family = caseEntry.descriptor.family;

    // 1) 草稿：公开读不可见。
    const created = await createDraft(caseEntry, service);
    assert.equal(typeof created.status, 'number');
    assert.equal(created.status, 201);
    const id = created.body.data.id;
    assert.equal(typeof id, 'string');
    assert.equal(created.body.data.revision, 1);
    assert.equal(view.readPublished(family, id), null, '草稿不得公开可见');
    assert.equal(view.isPubliclyVisible(family, id), false);

    // 2) 发布：公开读可见，且看到的是修订 1。
    const published = await publishRevision(caseEntry, service, id, 1);
    assert.equal(published.status, 200);
    assert.equal(published.body.data.changed, true, '首次发布真的迁移了状态，回执必须自报 changed: true');
    const live = view.readPublished(family, id);
    assert.notEqual(live, null, '发布后必须公开可见');
    assert.equal(live.revision, 1);
    assert.equal(typeof live.updated_at, 'string');

    // 3) 撤回：真正退出公开视图，但审计一条不少。
    const auditBefore = (await service.listAuditEvents(context())).body.data.items;
    assert.equal(auditBefore.length, 1, '发布恰好一条审计');
    assert.equal(auditBefore[0].action, `${caseEntry.noun}.publish`);
    assert.equal(auditBefore[0].result, 'accepted');
    assert.equal(auditBefore[0].target_ref.revision, 1);

    const withdrawn = await withdrawRevision(caseEntry, service, id, 1);
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.body.data.changed, true, '真实撤回真的迁出了公开视图，回执必须自报 changed: true');
    assert.equal(view.readPublished(family, id), null, '撤回后必须退出公开视图');
    assert.equal(view.isPubliclyVisible(family, id), false);

    const auditAfter = (await service.listAuditEvents(context())).body.data.items;
    assert.equal(auditAfter.length, 2, '撤回恰好再补一条审计');
    assert.equal(auditAfter[1].action, `${caseEntry.noun}.withdraw`);
    assert.equal(auditAfter[1].result, 'accepted');
    // 撤回的审计目标指向**当前生效的已发布修订**，可用于追溯。
    assert.equal(auditAfter[1].target_ref.revision, 1);
    assert.equal(typeof auditAfter[1].created_at, 'string');

    // 4) 撤回不删数据：修订 1 仍在库里。
    const entity = store.getEntity(id);
    assert.equal(entity.revisions.length, 1);
    assert.equal(entity.publishedRevision, 1);
    assert.equal(entity.lifecycle, 'withdrawn');

    observed.push({
      name: caseEntry.name,
      statuses: [created.status, published.status, withdrawn.status],
      headerKeys: [Object.keys(created.headers).sort(), Object.keys(withdrawn.headers).sort()],
      dataKeys: Object.keys(withdrawn.body.data).sort(),
      auditActions: auditAfter.map((event) => event.action),
    });
  }

  // 同一段脚本在四类资料上必须给出逐条同构的状态码与头部。
  const first = observed[0];
  for (const entry of observed) {
    assert.deepStrictEqual(entry.statuses, first.statuses, `${entry.name} 状态码序列与 sources 不同`);
    assert.deepStrictEqual(entry.headerKeys, first.headerKeys, `${entry.name} 响应头与 sources 不同`);
    assert.deepStrictEqual(entry.auditActions, [`${entry.name === 'sources' ? 'source' : entry.name.replace(/s$/, '')}.publish`, `${entry.name === 'sources' ? 'source' : entry.name.replace(/s$/, '')}.withdraw`]);
  }
  // 出参形状的差异必须**恰好**是已记录的那两处：sources 用 source、knowledge 多 visibility；
  // 另外 publish / withdraw 的出参比 create/get 多一个回执字段 `changed`（R64）。
  const byName = Object.fromEntries(observed.map((entry) => [entry.name, entry.dataKeys]));
  assert.deepStrictEqual(byName.sources, ['changed', 'id', 'revision', 'source', 'visibility']);
  assert.deepStrictEqual(byName.knowledge, ['changed', 'content', 'id', 'review_status', 'revision', 'visibility']);
  assert.deepStrictEqual(byName.registrations, ['changed', 'content', 'id', 'review_status', 'revision']);
  assert.deepStrictEqual(byName.restrictions, ['changed', 'content', 'id', 'review_status', 'revision']);
  // 只有 sources / knowledge 带 visibility；只有 sources 用 source 而不是 content。
  for (const name of ['registrations', 'restrictions']) {
    assert.equal(byName[name].includes('visibility'), false, `${name} 契约里没有 visibility`);
  }
});

test('已发布修订不可变：发布后编辑产生新草稿修订，旧修订正文一字不改且可追溯', async () => {
  for (const caseEntry of FAMILY_CASES) {
    const { service, view, store } = createHarness();
    const ops = caseEntry.ops(service);
    const family = caseEntry.descriptor.family;

    const original = caseEntry.contentInput();
    const originalSnapshot = structuredClone(original);

    const created = await createDraft(caseEntry, service, context(), original);
    const id = created.body.data.id;
    // 库里存的是副本：调用方事后改自己的对象动不了修订内容。
    assert.equal(tamperFirstString(original), true);
    assert.deepStrictEqual(store.getEntity(id).revisions[0].content, originalSnapshot, '入库修订必须是调用方对象的副本');

    await publishRevision(caseEntry, service, id, 1);
    const liveBefore = view.readPublished(family, id);
    assert.notEqual(liveBefore, null);
    const publishedContentSnapshot = structuredClone(liveBefore.content);

    // 发布后编辑：必须产生**新的**草稿修订，而不是改写已发布修订。
    const editedInput = caseEntry.editedInput();
    const edited = await editRevision(caseEntry, service, id, 1, editedInput);
    assert.equal(edited.status, 200);
    assert.equal(edited.body.data.revision, 2, '编辑必须追加新修订');
    assert.equal(edited.headers['ETag'], '"2"');

    // 已发布修订（修订 1）内容逐字不变，且公开读仍指向修订 1。
    const stored = store.getEntity(id);
    assert.equal(stored.revisions.length, 2);
    assert.deepStrictEqual(stored.revisions[0].content, originalSnapshot, '已发布修订被改写了');
    const liveAfter = view.readPublished(family, id);
    assert.notEqual(liveAfter, null);
    assert.equal(liveAfter.revision, 1, '新草稿未发布前，公开读必须仍是旧已发布修订');
    assert.deepStrictEqual(liveAfter.content, publishedContentSnapshot);

    // 旧修订可追溯。
    const traceable = view.traceableRevisions(family, id);
    assert.equal(traceable.length, 1);
    assert.equal(traceable[0].revision, 1);
    assert.deepStrictEqual(traceable[0].content, originalSnapshot);

    // 详情读到的 head 是新草稿：对外表现为未核验的私有草稿。
    const head = await ops.get(context(), id);
    assertMatchesContract(caseEntry.descriptor.envelopeSchema, head.body);
    assert.equal(head.body.data.revision, 2);
    if (caseEntry.descriptor.hasVisibility) {
      assert.equal(head.body.data.visibility, 'private', '新草稿不得表现为已发布');
    } else {
      // 契约缺口：RegistrationDraft / Restriction 没有 visibility 字段。
      assert.equal(Object.hasOwn(head.body.data, 'visibility'), false);
    }

    // 发布修订 2 之后：公开读切到修订 2，修订 1 仍在可追溯集合里。
    await publishRevision(caseEntry, service, id, 2);
    const liveFinal = view.readPublished(family, id);
    assert.equal(liveFinal.revision, 2);
    assert.deepStrictEqual(liveFinal.content, editedInput);
    const traceableFinal = view.traceableRevisions(family, id);
    assert.deepStrictEqual(traceableFinal.map((entry) => entry.revision), [1, 2]);
    assert.deepStrictEqual(traceableFinal[0].content, originalSnapshot, '修订 1 必须仍然可追溯且一字未改');
  }
});

test('撤回后再发布：同一修订可重新进入公开视图，且审计逐次追加', async () => {
  for (const caseEntry of FAMILY_CASES) {
    const { service, view } = createHarness();
    const family = caseEntry.descriptor.family;
    const created = await createDraft(caseEntry, service);
    const id = created.body.data.id;

    await publishRevision(caseEntry, service, id, 1);
    assert.notEqual(view.readPublished(family, id), null);
    await withdrawRevision(caseEntry, service, id, 1);
    assert.equal(view.readPublished(family, id), null);
    const republished = await publishRevision(caseEntry, service, id, 1);
    // 撤回后再发布：状态真的从 withdrawn 迁回 published ⇒ 回执必须自报 changed: true。
    assert.equal(republished.body.data.changed, true, '撤回后重新发布是真实状态迁移');
    const back = view.readPublished(family, id);
    assert.notEqual(back, null, '重新发布后必须再次公开可见');
    assert.equal(back.revision, 1);

    const events = (await service.listAuditEvents(context())).body.data.items;
    assert.deepStrictEqual(
      events.map((event) => `${event.action}:${event.result}`),
      [`${caseEntry.noun}.publish:accepted`, `${caseEntry.noun}.withdraw:accepted`, `${caseEntry.noun}.publish:accepted`],
    );
  }
});

test('重复 publish / 重复 withdraw 幂等：不再迁移状态、不重复记审计', async () => {
  for (const caseEntry of FAMILY_CASES) {
    const { service, view } = createHarness();
    const family = caseEntry.descriptor.family;
    const created = await createDraft(caseEntry, service);
    const id = created.body.data.id;

    await publishRevision(caseEntry, service, id, 1);
    // 换一个幂等键再发布一次：状态已达成 ⇒ 幂等成功，不再追加审计。
    const repeatPublish = await publishRevision(caseEntry, service, id, 1);
    assert.equal(repeatPublish.status, 200);
    // 诚实回执的负控制：状态本来就在目标状态 ⇒ `changed` 必须如实为 false（写死 true 会红）。
    assert.equal(repeatPublish.body.data.changed, false, '重复 publish 什么都没改，回执必须自报 changed: false');
    const afterRepeatPublish = (await service.listAuditEvents(context())).body.data.items;
    assert.equal(afterRepeatPublish.length, 1, '重复 publish 不得产生第二条审计');
    assert.equal(view.readPublished(family, id).revision, 1);

    await withdrawRevision(caseEntry, service, id, 1);
    const repeatWithdraw = await withdrawRevision(caseEntry, service, id, 1);
    assert.equal(repeatWithdraw.status, 200);
    assert.equal(repeatWithdraw.body.data.changed, false, '重复 withdraw 什么都没改，回执必须自报 changed: false');
    const afterRepeatWithdraw = (await service.listAuditEvents(context())).body.data.items;
    assert.equal(afterRepeatWithdraw.length, 2, '重复 withdraw 不得产生重复审计');
    assert.deepStrictEqual(
      afterRepeatWithdraw.map((event) => event.action),
      [`${caseEntry.noun}.publish`, `${caseEntry.noun}.withdraw`],
    );
  }
});

test('审计事件按时间升序可读，且 reason_code / scope 落在契约长度上限内', async () => {
  const { service } = createHarness();
  for (const caseEntry of FAMILY_CASES) {
    const created = await createDraft(caseEntry, service);
    const id = created.body.data.id;
    await publishRevision(caseEntry, service, id, 1);
    await withdrawRevision(caseEntry, service, id, 1);
  }
  const events = (await service.listAuditEvents(context())).body.data.items;
  assert.equal(events.length, 8);
  const times = events.map((event) => Date.parse(event.created_at));
  for (const time of times) assert.equal(typeof time, 'number');
  for (let index = 1; index < times.length; index += 1) {
    assert.ok(times[index] >= times[index - 1], '审计事件必须按时间升序可读');
  }
  for (const event of events) {
    assert.ok([...event.reason_code].length >= 1 && [...event.reason_code].length <= 80);
    assert.ok([...event.scope].length >= 1 && [...event.scope].length <= 80);
    assert.equal(event.scope, 'sources:write');
    assert.equal(event.result, 'accepted');
  }
  // 发布与撤回相间出现，且都带 revision。
  assert.deepStrictEqual(
    events.map((event) => event.action),
    ['source.publish', 'source.withdraw', 'knowledge.publish', 'knowledge.withdraw', 'registration.publish', 'registration.withdraw', 'restriction.publish', 'restriction.withdraw'],
  );
});

test('撤回从未发布的草稿被拒（OBJECT_UNAVAILABLE），且不产生任何审计或状态迁移', async () => {
  const caseEntry = FAMILY_CASES[0];
  const { service, view, store } = createHarness();
  const created = await createDraft(caseEntry, service);
  const id = created.body.data.id;

  await expectApiError(() => withdrawRevision(caseEntry, service, id, 1), 'OBJECT_UNAVAILABLE');
  assert.equal((await service.listAuditEvents(context())).body.data.items.length, 0);
  const entity = store.getEntity(id);
  assert.equal(entity.lifecycle, 'draft');
  assert.equal(entity.publishedRevision, null);
  assert.equal(view.readPublished('sources', id), null);
});
