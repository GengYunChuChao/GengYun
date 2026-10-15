// GY-I07 本片 · **公开读的「引用失效」判定**纯函数回归（`Refs #7`；跨线 `Refs #18`）。
//
// 覆盖：
//   P1. `unavailable` ⇒ `visible:false`：来源撤回后，**同一条已发布内容**立即判不可见，
//       且与既有后台公开读口径 `isPubliclyVisible` 结论一致（同一条判定，不是两套语义）；
//   P2. 来源发新版本 ⇒ 引用旧版本判 `unavailable`；改引新版本 ⇒ **恢复可见**
//       （失效是每次读取重算的判定，不是不可逆标记）；
//   P3. `unverifiable` ⇒ `visible:true`：引用**库外**来源核不到 ⇒ 保持可见、**不得谎称失效**
//       （含"库外引用不阻断既有发布链路"这条既有行为）；
//   P4. 边界：引用行本身写坏（缺 `source_version`）⇒ 既有语义 fail-closed 判 `unavailable`；
//       `sources` 家族自己不引用来源 ⇒ `available`。
//
// 说明：判定一律走**既有** `createReferenceIntegrity(store).resolve`（本片不复制语义）；
// 内容取自存储里**真实的已发布修订**，证明本片没有发明新的字段名或 id 命名空间。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  FAMILY_CASES,
  createDraft,
  createHarness,
  editRevision,
  publishRevision,
  validKnowledgeInput,
  validSourceInput,
  withdrawRevision,
} from './admin-fixtures.mjs';
import { createReferenceIntegrity } from '../../services/api/src/admin/reference-integrity.ts';
import { decidePublicVisibility } from '../../services/api/src/knowledge/public-invalidation.ts';

const [SOURCES, KNOWLEDGE] = FAMILY_CASES;
const SOURCE_VERSION = '2026-09';
const NEXT_SOURCE_VERSION = '2026-10';

/** 存储里该实体**已发布修订**的内容（就是公开读会喂给判定的那一份）。 */
function publishedContentOf(store, id) {
  const entity = store.getEntity(id);
  assert.ok(entity !== undefined, `期望存储里有 ${id}`);
  const revision = entity.revisions.find((entry) => entry.revision === entity.publishedRevision);
  assert.ok(revision !== undefined, '期望该实体存在已发布修订');
  return revision.content;
}

/**
 * 走既有 `resolve()` 判定；给了 `id` 就顺带对照既有公开读口径 `isPubliclyVisible`，
 * 两边结论必须一致（否则就是本片新造了语义）。
 */
function decide({ store, view, family, content, id }) {
  const integrity = createReferenceIntegrity(store);
  const decision = decidePublicVisibility({ family, content, resolve: integrity.resolve });
  assert.deepEqual(
    Object.keys(decision).sort(),
    ['reason', 'visible'],
    '结论形状固定为 { visible, reason }',
  );
  if (id !== undefined) {
    assert.equal(
      decision.visible,
      view.isPubliclyVisible(family, id),
      `${family}/${id}：纯判定必须与既有公开读口径同结论`,
    );
  }
  return decision;
}

test('P1. unavailable ⇒ visible:false：来源撤回后，同一条已发布内容立即判不可见', async () => {
  const harness = createHarness();
  const { service, store } = harness;

  const source = await createDraft(SOURCES, service);
  const sourceId = source.body.data.id;
  await publishRevision(SOURCES, service, sourceId, 1);

  const created = await createDraft(
    KNOWLEDGE,
    service,
    undefined,
    validKnowledgeInput({ source_id: sourceId, source_version: SOURCE_VERSION }),
  );
  const knowledgeId = created.body.data.id;
  await publishRevision(KNOWLEDGE, service, knowledgeId, 1);

  const content = publishedContentOf(store, knowledgeId);
  assert.equal(content.source_id, sourceId, '存储内容里的 source_id 就是既有字段（无新命名空间）');
  assert.equal(content.source_version, SOURCE_VERSION);

  assert.deepEqual(
    decide({ ...harness, family: 'knowledge', content, id: knowledgeId }),
    { visible: true, reason: 'available' },
    '撤回前：引用当前生效来源版本 ⇒ 可见',
  );

  await withdrawRevision(SOURCES, service, sourceId, 1);

  assert.deepEqual(
    decide({ ...harness, family: 'knowledge', content, id: knowledgeId }),
    { visible: false, reason: 'unavailable' },
    '来源撤回 ⇒ 公开读必须判不可见',
  );
  // 判定是读时重算：内容本身没有被改动过（不存在"标记失效"这种写动作）。
  assert.deepEqual(publishedContentOf(store, knowledgeId), content, '内容未被改写，失效只是读时结论');
});

test('P2. 来源发新版本 ⇒ 旧版本引用不可见；改引新版本 ⇒ 恢复可见（判定不是不可逆标记）', async () => {
  const harness = createHarness();
  const { service, store } = harness;

  const source = await createDraft(SOURCES, service);
  const sourceId = source.body.data.id;
  await publishRevision(SOURCES, service, sourceId, 1);

  const created = await createDraft(
    KNOWLEDGE,
    service,
    undefined,
    validKnowledgeInput({ source_id: sourceId, source_version: SOURCE_VERSION }),
  );
  const knowledgeId = created.body.data.id;
  await publishRevision(KNOWLEDGE, service, knowledgeId, 1);
  const content = publishedContentOf(store, knowledgeId);

  assert.equal(decide({ ...harness, family: 'knowledge', content, id: knowledgeId }).reason, 'available');

  // 来源改版：编辑（修订 2）+ 发布 ⇒ 生效版本变成 2026-10。
  await editRevision(SOURCES, service, sourceId, 1, validSourceInput({ version: NEXT_SOURCE_VERSION }));
  await publishRevision(SOURCES, service, sourceId, 2);

  assert.deepEqual(
    decide({ ...harness, family: 'knowledge', content, id: knowledgeId }),
    { visible: false, reason: 'unavailable' },
    '仍引用旧版本 ⇒ 立即不可见（不是只有"下架"才失效）',
  );

  // 正控制：改引来源当前生效版本并发布 ⇒ 同一条资料的公开读恢复可见（读时重算，无需清缓存）。
  await editRevision(
    KNOWLEDGE,
    service,
    knowledgeId,
    1,
    validKnowledgeInput({ source_id: sourceId, source_version: NEXT_SOURCE_VERSION }),
  );
  await publishRevision(KNOWLEDGE, service, knowledgeId, 2);
  const revalidated = publishedContentOf(store, knowledgeId);
  assert.equal(revalidated.source_version, NEXT_SOURCE_VERSION);
  assert.deepEqual(
    decide({ ...harness, family: 'knowledge', content: revalidated, id: knowledgeId }),
    { visible: true, reason: 'available' },
    '重新校验到新版本 ⇒ 恢复可见',
  );
});

test('P3. unverifiable ⇒ visible:true：库外来源核不到 ⇒ 保持可见，不谎称失效', async () => {
  const harness = createHarness();
  const { service, store } = harness;
  const unknownSourceId = randomUUID();

  // 库外来源：存储里没有这条来源 ⇒ 核不到（生产默认：后台 store 里没有真实来源库）。
  const bare = validKnowledgeInput({ source_id: unknownSourceId, source_version: SOURCE_VERSION });
  assert.equal(
    createReferenceIntegrity(store).resolve('knowledge', bare).state,
    'unverifiable',
    '空存储 + 库外来源 ⇒ 既有语义判 unverifiable（不是 unavailable）',
  );
  assert.deepEqual(
    decidePublicVisibility({ family: 'knowledge', content: bare, resolve: createReferenceIntegrity(store).resolve }),
    { visible: true, reason: 'unverifiable' },
    '核不到 ⇒ 保持可见，不得谎称失效',
  );

  // 既有行为不越界：库外引用**不**阻断发布链路，且发布后公开读仍可见。
  const created = await createDraft(
    KNOWLEDGE,
    service,
    undefined,
    validKnowledgeInput({ source_id: unknownSourceId, source_version: SOURCE_VERSION }),
  );
  const knowledgeId = created.body.data.id;
  await publishRevision(KNOWLEDGE, service, knowledgeId, 1);

  assert.deepEqual(
    decide({ ...harness, family: 'knowledge', content: publishedContentOf(store, knowledgeId), id: knowledgeId }),
    { visible: true, reason: 'unverifiable' },
    '库外引用发布后：公开读保持可见（生产默认行为不变）',
  );
});

test('P4. 边界：引用行写坏 ⇒ 既有语义 fail-closed；sources 自己不引用来源 ⇒ available', async () => {
  const { store, view } = createHarness();
  const integrity = createReferenceIntegrity(store);

  // 引用行缺 source_version：属既有 `source_reference_malformed` 分支，本片只如实转发。
  assert.deepEqual(
    decidePublicVisibility({ family: 'knowledge', content: { source_id: randomUUID() }, resolve: integrity.resolve }),
    { visible: false, reason: 'unavailable' },
    '引用行本身不可核对 ⇒ fail-closed（既有语义，非本片新增）',
  );

  // sources 家族自己不引用任何来源 ⇒ dependent:false ⇒ available（本片不额外造特例）。
  const sourceContent = validSourceInput();
  assert.equal(integrity.resolve('sources', sourceContent).dependent, false);
  assert.deepEqual(
    decidePublicVisibility({ family: 'sources', content: sourceContent, resolve: integrity.resolve }),
    { visible: true, reason: 'available' },
  );
  assert.equal(view.isPubliclyVisible('sources', randomUUID()), false, 'sanity：不存在的实体不可见');
});
