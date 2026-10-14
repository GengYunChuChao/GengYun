// GY-I18 本片 · **来源修改/下架 ⇒ 引用同步失效** 的回归（`Refs #18`）。
//
// 覆盖（全部为实测断言）：
//   1. 三类依赖（knowledge / registrations / restrictions）引用同一来源 ⇒ 来源下架后**同时**失效；
//   2. **负例**：失效之前拿到的"缓存副本"与"旧链接（同一 id）"都不得让内容复活；
//   3. **改版即失效**：来源发新版本 ⇒ 仍引用旧版本的依赖失效（不是只有"下架"才失效）；
//   4. **重新校验后恢复**：依赖改引新版本并发布 ⇒ 重新可用（失效是判定，不是不可逆标记）；
//   5. **发布门槛**：引用已失效/未发布来源的依赖发布 ⇒ 422 SOURCE_CONFLICT，且**不部分发布**；
//   6. **审计责任人与范围**：来源发布/撤回的审计记录留下主体与"影响了几条引用、其中几条失效"；
//   7. **读取时重查权限**：别的后台主体读同一 id ⇒ NOT_FOUND（与"不存在"同形，读时才判）；
//   8. **不越界**：引用库外来源（未接真实库无法核对）⇒ 不谎称失效、也不阻断既有发布链路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILY_CASES,
  OTHER_STEWARD,
  STEWARD,
  adminIdentity,
  context,
  createDraft,
  createHarness,
  editRevision,
  expectApiError,
  publishRevision,
  validKnowledgeInput,
  validRegistrationInput,
  validRestrictionInput,
  validSourceInput,
  withdrawRevision,
} from './admin-fixtures.mjs';

const [SOURCES, KNOWLEDGE, REGISTRATIONS, RESTRICTIONS] = FAMILY_CASES;
const SOURCE_VERSION = '2026-09';
const NEXT_SOURCE_VERSION = '2026-10';

/**
 * 建一条来源 + 三类依赖（都引用该来源的 `2026-09`），并把四者都发布出去。
 * 返回 id 便于后续按"旧链接"重读。
 */
async function seedSourceWithThreeDependents() {
  const harness = createHarness();
  const { service } = harness;
  const source = await createDraft(SOURCES, service);
  const sourceId = source.body.data.id;
  await publishRevision(SOURCES, service, sourceId, 1);

  const knowledge = await createDraft(KNOWLEDGE, service, context(), validKnowledgeInput({ source_id: sourceId, source_version: SOURCE_VERSION }));
  const registration = await createDraft(REGISTRATIONS, service, context(), validRegistrationInput({ source_id: sourceId, source_version: SOURCE_VERSION }));
  const restriction = await createDraft(RESTRICTIONS, service, context(), validRestrictionInput({ source_id: sourceId, source_version: SOURCE_VERSION }));
  await publishRevision(KNOWLEDGE, service, knowledge.body.data.id, 1);
  await publishRevision(REGISTRATIONS, service, registration.body.data.id, 1);
  await publishRevision(RESTRICTIONS, service, restriction.body.data.id, 1);

  return {
    ...harness,
    sourceId,
    ids: {
      knowledge: knowledge.body.data.id,
      registrations: registration.body.data.id,
      restrictions: restriction.body.data.id,
    },
  };
}

function visibilityOf(view, ids) {
  return {
    knowledge: view.isPubliclyVisible('knowledge', ids.knowledge),
    registrations: view.isPubliclyVisible('registrations', ids.registrations),
    restrictions: view.isPubliclyVisible('restrictions', ids.restrictions),
  };
}

test('1. 引用同一来源的三类依赖在来源下架后**同时**失效（读取时重算，不是清缓存动作）', async () => {
  const { service, view, sourceId, ids } = await seedSourceWithThreeDependents();
  assert.deepEqual(visibilityOf(view, ids), { knowledge: true, registrations: true, restrictions: true }, '下架前：三类依赖都可见');

  await withdrawRevision(SOURCES, service, sourceId, 1);

  assert.deepEqual(visibilityOf(view, ids), { knowledge: false, registrations: false, restrictions: false }, '下架后三类依赖必须同时失效');
  for (const [family, id] of Object.entries(ids)) {
    assert.equal(view.readPublished(family, id), null, `${family} 公开读必须为 null`);
    const availability = view.availabilityOf(family, id);
    assert.equal(availability.state, 'unavailable', family);
    assert.equal(availability.reason, 'source_withdrawn', family);
    assert.equal(availability.sourceId, sourceId, family);
    assert.equal(availability.referencedVersion, SOURCE_VERSION, family);
  }
  // 来源自己下架后，其自身也不再公开可见（与既有生命周期口径一致）。
  assert.equal(view.isPubliclyVisible('sources', sourceId), false);
});

test('2. 负例：失效前拿到的缓存副本与旧链接都不得让内容复活', async () => {
  const { service, view, store, sourceId, ids } = await seedSourceWithThreeDependents();

  // 「缓存副本」：失效前的一次公开读结果（出口深拷贝，调用方自有）。
  const cached = view.readPublished('knowledge', ids.knowledge);
  assert.equal(typeof cached, 'object');
  const cachedBody = cached.content.body;

  await withdrawRevision(SOURCES, service, sourceId, 1);

  // 旧链接（同一个 id 再读一次）⇒ null，不会因为"曾经读过"而复活。
  assert.equal(view.readPublished('knowledge', ids.knowledge), null, '旧链接不得复活已失效内容');
  assert.equal(view.isPubliclyVisible('knowledge', ids.knowledge), false);
  // 缓存副本仍是调用方自有的普通对象，但**平台不会**再次以它作为响应来源：
  // 篡改副本既不改存储，也不改变读取结论。
  cached.content.body = '被缓存副本改写';
  assert.equal(view.readPublished('knowledge', ids.knowledge), null);
  const entity = store.getEntity(ids.knowledge);
  assert.notEqual(entity.revisions[0].content.body, '被缓存副本改写', '存储侧不得被副本改写');
  assert.equal(entity.revisions[0].content.body, cachedBody);
});

test('3. 改版即失效：来源发新版本后，仍引用旧版本的依赖失效（不是只有下架才算失效）', async () => {
  const { service, view, sourceId, ids } = await seedSourceWithThreeDependents();
  await withdrawRevision(SOURCES, service, sourceId, 1);
  // 来源改版到 2026-10 并重新发布。
  await editRevision(SOURCES, service, sourceId, 1, validSourceInput({ version: NEXT_SOURCE_VERSION }));
  await publishRevision(SOURCES, service, sourceId, 2);

  const availability = view.availabilityOf('knowledge', ids.knowledge);
  assert.equal(availability.state, 'unavailable');
  assert.equal(availability.reason, 'source_version_mismatch');
  assert.equal(availability.referencedVersion, SOURCE_VERSION);
  assert.equal(availability.liveVersion, NEXT_SOURCE_VERSION, '来源当前生效版本必须是新版本');
  assert.equal(view.readPublished('knowledge', ids.knowledge), null);
  // 来源自身（新版本）是可见的 —— 失效只作用于"还指着旧版本"的引用。
  assert.equal(view.readPublished('sources', sourceId) !== null, true);
});

test('4. 重新校验后恢复：依赖改引新版本并发布 ⇒ 重新可用（失效是判定，不是不可逆标记）', async () => {
  const { service, view, sourceId, ids } = await seedSourceWithThreeDependents();
  await withdrawRevision(SOURCES, service, sourceId, 1);
  await editRevision(SOURCES, service, sourceId, 1, validSourceInput({ version: NEXT_SOURCE_VERSION }));
  await publishRevision(SOURCES, service, sourceId, 2);
  assert.equal(view.isPubliclyVisible('knowledge', ids.knowledge), false);

  await editRevision(KNOWLEDGE, service, ids.knowledge, 1, validKnowledgeInput({ source_id: sourceId, source_version: NEXT_SOURCE_VERSION }));
  await publishRevision(KNOWLEDGE, service, ids.knowledge, 2);

  assert.equal(view.isPubliclyVisible('knowledge', ids.knowledge), true, '改引新版本后必须恢复可见');
  assert.equal(view.availabilityOf('knowledge', ids.knowledge).state, 'available');
  // 未重新校验的另两类依赖仍然失效（逐个判定，不"一刀切恢复"）。
  assert.deepEqual(visibilityOf(view, ids), { knowledge: true, registrations: false, restrictions: false });
});

test('5. 发布门槛：引用已下架来源的依赖发布 ⇒ 422 SOURCE_CONFLICT，且**不部分发布**、留 denied 审计', async () => {
  const { service, store, sourceId, ids } = await seedSourceWithThreeDependents();
  await withdrawRevision(SOURCES, service, sourceId, 1);

  const draft = await createDraft(KNOWLEDGE, service, context(), validKnowledgeInput({ source_id: sourceId, source_version: SOURCE_VERSION }));
  const draftId = draft.body.data.id;
  const auditsBefore = store.audit.count();

  const error = await expectApiError(() => publishRevision(KNOWLEDGE, service, draftId, 1), 'SOURCE_CONFLICT');
  assert.equal(error.status, 422, '契约 error_status_map：SOURCE_CONFLICT ⇒ 422');
  assert.deepEqual(error.details, [{ field: 'source_id', code: 'source_withdrawn' }]);

  const entity = store.getEntity(draftId);
  assert.equal(entity.lifecycle, 'draft', '被拒的发布不得部分生效');
  assert.equal(entity.publishedRevision, null);

  const appended = store.audit.list().slice(auditsBefore);
  assert.equal(appended.length, 1, '被拒的发布恰好留一条 denied 审计');
  assert.equal(appended[0].result, 'denied');
  assert.equal(appended[0].reason_code, 'publish_gate_denied:reference_source_withdrawn');
  assert.equal(appended[0].actor_id, STEWARD, 'denied 审计同样必须留责任人');
});

test('6. 审计责任人与范围：来源撤回记录受影响引用范围（refs / invalidated）', async () => {
  const { service, store, sourceId, ids } = await seedSourceWithThreeDependents();
  // 发布一条不在本存储里的来源引用（unverifiable）不应影响本用例的范围计数。
  await withdrawRevision(SOURCES, service, sourceId, 1);

  const withdrawEvent = store.audit.list().filter((record) => record.action === 'source.withdraw').at(-1);
  assert.equal(withdrawEvent.actor_id, STEWARD);
  assert.equal(withdrawEvent.scope, 'sources:write');
  assert.equal(withdrawEvent.result, 'accepted');
  assert.equal(withdrawEvent.target_ref.type, 'source');
  assert.equal(withdrawEvent.target_ref.id, sourceId);
  assert.equal(withdrawEvent.target_ref.revision, 1);
  const match = /^source:(.+):rev=1:live=none:refs=(\d+):invalidated=(\d+)$/.exec(withdrawEvent.target_hint);
  assert.ok(match, `撤回审计必须带范围：${withdrawEvent.target_hint}`);
  assert.equal(match[1], sourceId);
  assert.equal(Number(match[2]), 3, '引用该来源的依赖共 3 条');
  assert.equal(Number(match[3]), 3, '撤回后 3 条全部失效');
  assert.equal(store.audit.list().filter((record) => record.action === 'source.withdraw').length, 1, '撤回只记一次');
  assert.equal(ids.knowledge.length > 0, true, 'sanity');
});

test('7. 读取时重查权限：别的后台主体读同一 id ⇒ NOT_FOUND（与不存在同形）', async () => {
  const { service, view, sourceId, ids } = await seedSourceWithThreeDependents();
  const other = { identity: adminIdentity({ userId: OTHER_STEWARD }) };

  await expectApiError(() => service.getAdminKnowledge({ ...other }, ids.knowledge), 'NOT_FOUND');
  await expectApiError(() => service.editKnowledgeDraft({ ...other, idempotencyKey: 'gy-i18-other-edit-0001', ifMatch: '"1"' }, ids.knowledge, validKnowledgeInput({ source_id: sourceId, source_version: SOURCE_VERSION })), 'NOT_FOUND');
  // 公开读口径本身不按主体过滤（它不是 HTTP 面），但**引用可用性**与管辖无关：
  // 下架来源后，任何主体读到的判定都一致。
  await withdrawRevision(SOURCES, service, sourceId, 1);
  assert.equal(view.isPubliclyVisible('knowledge', ids.knowledge), false);
});

test('8. 不越界：引用库外来源（未接真实库无法核对）⇒ 不谎称失效、也不阻断既有发布链路', async () => {
  const { service, store, view } = createHarness();
  const outsideSourceId = '99999999-9999-4999-8999-999999999999';
  const knowledge = await createDraft(KNOWLEDGE, service, context(), validKnowledgeInput({ source_id: outsideSourceId, source_version: SOURCE_VERSION }));
  const id = knowledge.body.data.id;

  // 发布必须**成功**（`unverifiable` 不拦），否则"没有真实库"会变成整个前台发不出内容。
  const published = await publishRevision(KNOWLEDGE, service, id, 1);
  assert.equal(published.status, 200);
  assert.equal(store.getEntity(id).lifecycle, 'published');

  // 公开读保持既有可见性（如实登记为"无法核对"，不伪造"已核对"也不伪造"失效"）。
  assert.equal(view.isPubliclyVisible('knowledge', id), true);
  const availability = view.availabilityOf('knowledge', id);
  assert.equal(availability.state, 'unverifiable');
  assert.equal(availability.reason, 'source_not_in_store');
  assert.equal(availability.sourceId, outsideSourceId);
});
