/**
 * GY-I18 阶段 1 · 返修 1：已发布修订存在可变存储引用（监工 5487925429 / 行内 4245801050）。
 *
 * 缺陷本质：`knowledge` / `registrations` / `restrictions` 的投影把
 * `revision.content` **原对象**交给调用方，`appendRevision` 又没有冻结它。
 * 于是「拿响应改一改」就能改写已发布正文，且 **revision 不变、审计条数不变**，
 * 绕过本片承诺的「已发布正文不可变、修改必须追加修订」。
 *
 * 本文件先以**失败**形态复现该缺陷，修好后必须全绿：
 * - 入口冻结：存储修订及其**嵌套**对象深冻结 ⇒ 越界改动直接抛 TypeError（行为可判定）；
 * - 出口深拷贝：所有读/写响应、公开视图与历史视图一律返回**深拷贝**（不是浅拷贝）。
 * 两条并用：冻结是结构性不变量（fail loud），拷贝让调用方拿到自有普通数据（零共享引用）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILY_CASES,
  context,
  createDraft,
  createHarness,
  editRevision,
  idempotencyKey,
  publishRevision,
  validPublishBody,
  validWithdrawBody,
} from './admin-fixtures.mjs';

const KNOWLEDGE = FAMILY_CASES[1];

/**
 * 固定 request_id：重复读同一资源时 `meta` 必须逐字可比，
 * 否则每次调用新生成的 uuid 会把「真的被改写」和「正常换 id」混在一起。
 */
const FIXED_REQUEST_ID = '1f0f4a2c-3b7d-4e58-9a11-2c6d8e0f4b93';
const fixedCtx = (overrides = {}) => ({ ...context(), requestId: FIXED_REQUEST_ID, ...overrides });

/**
 * 每类资料的**嵌套**字段改写器（浅层字段不算数：本次缺陷就在嵌套层）。
 * 返回被改写的路径，便于失败信息定位。
 */
const NESTED_MUTATORS = {
  knowledge: (data) => {
    data.content.body = 'MUTATED-BODY';
    return 'content.body';
  },
  registrations: (data) => {
    data.content.formulation.ingredients[0].name = 'MUTATED-INGREDIENT';
    return 'content.formulation.ingredients[0].name';
  },
  restrictions: (data) => {
    data.content.conditions.region_code = '999999';
    return 'content.conditions.region_code';
  },
  sources: (data) => {
    data.source.title = 'MUTATED-TITLE';
    return 'source.title';
  },
};

/** 递归断言：响应对象图里**不得**出现冻结对象（存储修订全部已冻结 ⇒ 出现即等于引用泄漏）。 */
function assertNoFrozenNodes(value, path, seen = new Set()) {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  assert.equal(
    Object.isFrozen(value),
    false,
    `${path} 是冻结对象，说明响应里混进了存储修订的引用（应为深拷贝）`,
  );
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoFrozenNodes(item, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) assertNoFrozenNodes(child, `${path}.${key}`, seen);
}

test('主反例：改写 getAdminKnowledge 响应里的嵌套 content.body，不得改变存储（revision 仍 1、审计仍 1 条）', async () => {
  const { service, store, view } = createHarness();
  const input = KNOWLEDGE.contentInput();
  const snapshot = structuredClone(input);
  const created = await createDraft(KNOWLEDGE, service, fixedCtx(), input);
  const id = created.body.data.id;
  await publishRevision(KNOWLEDGE, service, id, 1);

  const before = await service.getAdminKnowledge(fixedCtx(), id);
  assert.equal(typeof before.body.data.revision, 'number');
  assert.equal(before.body.data.revision, 1);
  assert.equal(typeof before.body.data.content.body, 'string');
  const beforeBodyValue = before.body.data.content.body;
  const auditBefore = (await service.listAuditEvents(fixedCtx())).body.data.items;
  assert.equal(auditBefore.length, 1);

  // 监工复现的原话：直接给响应里的嵌套字段赋新值。
  before.body.data.content.body = '被响应改写的正文';

  const after = await service.getAdminKnowledge(fixedCtx(), id);
  assert.equal(after.body.data.revision, 1, 'revision 不得因响应被改写而变化');
  assert.equal(typeof after.body.data.content.body, 'string');
  assert.equal(after.body.data.content.body, beforeBodyValue, '存储正文被响应改写了');
  assert.deepStrictEqual(after.body.data.content, snapshot, '存储内容必须仍等于最初入库的正文');
  assert.equal((await service.listAuditEvents(fixedCtx())).body.data.items.length, 1, '审计条数不得变化');

  // 公开视图同样不得被污染。
  const published = view.readPublished('knowledge', id);
  assert.notEqual(published, null);
  assert.equal(published.content.body, snapshot.body, '公开视图被响应改写的值污染了');
  // 库里最后一个修订也必须没被动过。
  assert.equal(store.getEntity(id).revisions.at(-1).content.body, snapshot.body);
});

test('反例（嵌套）：四类资料的详情/列表/编辑响应改写嵌套字段，均不得改变存储', async () => {
  for (const caseEntry of FAMILY_CASES) {
    const mutate = NESTED_MUTATORS[caseEntry.name];
    assert.equal(typeof mutate, 'function', `${caseEntry.name} 缺少嵌套改写器`);
    const { service, store, view } = createHarness();
    const input = caseEntry.contentInput();
    const snapshot = structuredClone(input);
    const ops = caseEntry.ops(service);
    const created = await createDraft(caseEntry, service, fixedCtx(), input);
    const id = created.body.data.id;
    await publishRevision(caseEntry, service, id, 1);

    const detail = await ops.get(fixedCtx(), id);
    const detailBaseline = structuredClone(detail.body);
    const mutatedPath = mutate(detail.body.data);
    assert.equal(typeof mutatedPath, 'string');

    // 1) 再次详情读：必须与首次读逐字一致。
    const again = await ops.get(fixedCtx(), id);
    assert.deepStrictEqual(again.body, detailBaseline, `${caseEntry.name} 的详情存储被响应改写（${mutatedPath}）`);

    // 2) 列表响应同样不得暴露可变引用。
    const listed = await ops.list(fixedCtx());
    const listedBaseline = structuredClone(listed.body);
    assert.equal(listed.body.data.items.length, 1);
    mutate(listed.body.data.items[0]);
    const listedAgain = await ops.list(fixedCtx());
    assert.deepStrictEqual(listedAgain.body, listedBaseline, `${caseEntry.name} 的列表存储被响应改写`);

    // 3) 库里修订内容未被改动，公开视图也未变。
    assert.deepStrictEqual(store.getEntity(id).revisions[0].content, snapshot, `${caseEntry.name} 存储修订被改写`);
    const published = view.readPublished(caseEntry.descriptor.family, id);
    assert.notEqual(published, null);
    assert.deepStrictEqual(published.content, snapshot, `${caseEntry.name} 公开视图被响应改写污染`);

    // 4) 编辑响应也不得是可变存储引用。
    const edited = await editRevision(caseEntry, service, id, 1, caseEntry.editedInput(), fixedCtx());
    const editedBaseline = structuredClone(edited.body);
    mutate(edited.body.data);
    const reread = await ops.get(fixedCtx(), id);
    assert.deepStrictEqual(reread.body, editedBaseline, `${caseEntry.name} 的编辑响应泄漏了存储引用`);
  }
});

test('反例：公开视图与历史/版本视图的返回值不得是可变存储引用', async () => {
  for (const caseEntry of FAMILY_CASES) {
    const { service, view, store } = createHarness();
    const family = caseEntry.descriptor.family;
    const input = caseEntry.contentInput();
    const snapshot = structuredClone(input);
    const created = await createDraft(caseEntry, service, fixedCtx(), input);
    const id = created.body.data.id;
    await publishRevision(caseEntry, service, id, 1);

    // 公开视图
    const published = view.readPublished(family, id);
    assert.equal(typeof published.revision, 'number');
    assert.equal(published.revision, 1);
    const publishedBaseline = structuredClone(published);
    mutateProjection(published.content);

    const publishedAgain = view.readPublished(family, id);
    assert.deepStrictEqual(publishedAgain, publishedBaseline, `${caseEntry.name} 公开视图返回值是可变存储引用`);
    assert.deepStrictEqual(store.getEntity(id).revisions[0].content, snapshot);
    // 「来源绑定」= 公开视图认定的修订号与其内容，都不得被改写。
    assert.equal(publishedAgain.revision, 1);

    // 历史/版本视图
    const traceable = view.traceableRevisions(family, id);
    const traceableBaseline = structuredClone(traceable);
    assert.equal(traceable.length, 1);
    mutateProjection(traceable[0].content);
    const traceableAgain = view.traceableRevisions(family, id);
    assert.deepStrictEqual(traceableAgain, traceableBaseline, `${caseEntry.name} 历史视图返回值是可变存储引用`);
    assert.deepStrictEqual(store.getEntity(id).revisions[0].content, snapshot);
  }
});

test('反例：改写响应不得影响后续 edit/publish 的结果（写入路径隔离）', async () => {
  const { service, store, view } = createHarness();
  const input = KNOWLEDGE.contentInput();
  const snapshot = structuredClone(input);
  const created = await createDraft(KNOWLEDGE, service, fixedCtx(), input);
  const id = created.body.data.id;

  // 改创建响应里的嵌套字段。
  created.body.data.content.body = '被创建响应改写';
  created.body.data.content.conditions.region_code = '999999';

  // 随后发布：发布出去的必须是最初入库的正文，不是被改写的值。
  await publishRevision(KNOWLEDGE, service, id, 1);
  const live = view.readPublished('knowledge', id);
  assert.equal(live.content.body, snapshot.body, 'publish 结果被创建响应的改写污染');
  assert.deepStrictEqual(live.content.conditions, snapshot.conditions);
  assert.equal(store.getEntity(id).revisions.length, 1, '不得凭空多出一条修订');

  // 改详情响应后编辑：新修订必须恰好是传入的新正文，且旧修订逐字不变。
  const detail = await service.getAdminKnowledge(fixedCtx(), id);
  detail.body.data.content.body = '被详情响应改写';
  const newInput = KNOWLEDGE.editedInput();
  const edited = await editRevision(KNOWLEDGE, service, id, 1, newInput);
  assert.equal(edited.body.data.revision, 2, 'edit 不得凭空多出修订');
  const entity = store.getEntity(id);
  assert.equal(entity.revisions.length, 2);
  assert.deepStrictEqual(entity.revisions[0].content, snapshot, 'edit 前的已发布修订被响应改写污染');
  assert.deepStrictEqual(entity.revisions[1].content, newInput, '新修订内容不是传入值，说明被响应改写污染');

  // 改发布响应后撤回：撤回结果与审计不得受影响。
  const publishedAgain = await publishRevision(KNOWLEDGE, service, id, 2);
  publishedAgain.body.data.content.body = '被发布响应改写';
  await service.withdrawKnowledge(
    { ...fixedCtx(), idempotencyKey: idempotencyKey('w'), ifMatch: '"2"' },
    id,
    validWithdrawBody(),
  );
  assert.equal(view.readPublished('knowledge', id), null, '撤回后必须退出公开视图');
  const events = (await service.listAuditEvents(fixedCtx())).body.data.items;
  // 本片新增：编辑（= 追加新版本）也是关键修改 ⇒ 必须留审计（此前不写，事后无法追责）。
  assert.deepStrictEqual(events.map((event) => `${event.action}@${event.target_ref.revision}`), ['knowledge.publish@1', 'knowledge.edit@2', 'knowledge.publish@2', 'knowledge.withdraw@2']);
  assert.deepStrictEqual(store.getEntity(id).revisions[1].content, newInput);
});

test('入口冻结：存储修订及其嵌套对象已冻结，外部越界改动明确抛 TypeError', async () => {
  for (const caseEntry of FAMILY_CASES) {
    const { service, store } = createHarness();
    const created = await createDraft(caseEntry, service);
    const id = created.body.data.id;
    const revision = store.getEntity(id).revisions[0];

    // 1) 修订本体与嵌套对象都已深冻结。
    assert.equal(typeof revision.content, 'object');
    assert.equal(Object.isFrozen(revision), true, `${caseEntry.name} 的存储修订未冻结`);
    assertDeepFrozen(revision.content, `${caseEntry.name}.revision.content`);

    // 2) 越界改动「直接抛错」（本片选择的语义），因此行为可判定。
    assert.throws(() => {
      revision.content.unexpected = 'x';
    }, TypeError, `${caseEntry.name} 的改冻结内容未抛错`);

    // 3) 响应对象本身**不是**冻结对象：调用方拿到的是自有的普通深拷贝（零共享引用）。
    const response = await caseEntry.ops(service).get(fixedCtx(), id);
    const storedContent = store.getEntity(id).revisions[0].content;
    assert.equal(Object.isFrozen(response.body.data), false, '响应应是可变的自有副本');
    assert.equal(
      typeof response.body.data.content === 'object' || typeof response.body.data.source === 'object',
      true,
      '响应里必须能读到内容',
    );
    // 改自己的副本不抛错（它是普通可变对象），但库里的值一个字都不能变。
    if (response.body.data.content !== undefined) {
      const storedBodyBefore = storedContent.body;
      response.body.data.content.body = 'LOCAL-ONLY';
      assert.notEqual(storedContent.body, 'LOCAL-ONLY', `${caseEntry.name} 的库内容被响应改写`);
      assert.equal(storedContent.body, storedBodyBefore);
    } else {
      const storedTitleBefore = storedContent.title;
      response.body.data.source.title = 'LOCAL-ONLY';
      assert.notEqual(storedContent.title, 'LOCAL-ONLY', `${caseEntry.name} 的库内容被响应改写`);
      assert.equal(storedContent.title, storedTitleBefore);
    }
  }
});

test('结构性检查：25 个操作的响应对象图里不存在任何冻结对象（= 不含存储修订引用）', async () => {
  const { service } = createHarness();
  const seenResponses = [];

  const record = (label, response) => {
    assert.equal(typeof response.status, 'number', `${label} 缺 status`);
    assert.equal(typeof response.body, 'object');
    assertNoFrozenNodes(response.headers, `${label}.headers`);
    assertNoFrozenNodes(response.body, `${label}.body`);
    seenResponses.push(label);
  };

  for (const caseEntry of FAMILY_CASES) {
    const ops = caseEntry.ops(service);
    const created = await createDraft(caseEntry, service);
    const id = created.body.data.id;
    record(`${caseEntry.name}.create`, created);
    record(`${caseEntry.name}.get`, await ops.get(fixedCtx(), id));
    record(`${caseEntry.name}.edit`, await editRevision(caseEntry, service, id, 1, caseEntry.editedInput()));
    record(`${caseEntry.name}.publish`, await publishRevision(caseEntry, service, id, 2));
    record(`${caseEntry.name}.list`, await ops.list(fixedCtx()));
    record(
      `${caseEntry.name}.withdraw`,
      await ops.withdraw({ ...fixedCtx(), idempotencyKey: idempotencyKey('w'), ifMatch: '"2"' }, id, validWithdrawBody()),
    );
  }
  record('audit.list', await service.listAuditEvents(fixedCtx()));

  // 25 个 operationId 全部被走到（四类 × 6 + 审计 1）。
  assert.equal(seenResponses.length, 25, `只覆盖了 ${seenResponses.length} 个响应`);
  assert.equal(
    new Set(seenResponses.map((label) => label.split('.')[1])).size,
    6,
    '六种动作都要覆盖到',
  );
});

test('回归：审计响应同样不暴露可变内部状态（内部记录已冻结，契约出口是副本）', async () => {
  const { service, store } = createHarness();
  const created = await createDraft(KNOWLEDGE, service);
  const id = created.body.data.id;
  await publishRevision(KNOWLEDGE, service, id, 1);

  const internal = store.audit.list();
  assert.equal(Object.isFrozen(internal), true);
  assert.equal(Object.isFrozen(internal[0]), true);

  // 固定 request_id，避免把「每次调用生成的 uuid」误判成被改写。
  const fixedRequestId = '9f1c8a52-0f4e-4a6f-9d2b-5b0d3f1e7c44';
  const readAudit = () => service.listAuditEvents({ ...fixedCtx(), requestId: fixedRequestId });
  const response = await readAudit();
  const item = response.body.data.items[0];
  assert.equal(typeof item, 'object');
  assert.equal(Object.isFrozen(item), false, '契约出口必须是副本，不能是冻结的内部记录');
  const baseline = structuredClone(response.body);
  item.target_ref.revision = 999;
  item.action = 'tampered';
  const again = await readAudit();
  assert.deepStrictEqual(again.body, baseline, '审计出口被改写污染');
  assert.equal(store.audit.count(), 1);
});

/** 递归断言：存储侧对象图必须**全部**冻结（含嵌套对象与数组）。 */
function assertDeepFrozen(value, path) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true, `${path} 未冻结（嵌套层也要冻）`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertDeepFrozen(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) assertDeepFrozen(child, `${path}.${key}`);
}

/** 改写投影里的任意嵌套字符串字段（公开视图/历史视图用）。 */
function mutateProjection(content) {
  if (content === null || typeof content !== 'object') return;
  for (const [key, child] of Object.entries(content)) {
    if (typeof child === 'string') {
      content[key] = `${child}-MUTATED`;
      return;
    }
    if (child !== null && typeof child === 'object') {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item !== null && typeof item === 'object') mutateProjection(item);
        }
        continue;
      }
      mutateProjection(child);
      return;
    }
  }
}
