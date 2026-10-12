/**
 * GY-I18 阶段 1 · 独立反例（每条都能单独指出，且都带正控制对照）。
 *
 * 反例类别（≥14，逐条独立）：
 *  1 非 admin（用户会话）
 *  2 admin 但缺写 scope
 *  3 越权目标（他人管辖）与「不存在」对外同形
 *  4 跨家族 id 混淆
 *  5 编辑不得改写已发布正文（只生成新草稿修订）
 *  6 发布体必填缺失
 *  7 发布体超长
 *  8 正文超长
 *  9 闭集外枚举（source_kind / knowledge.type / restriction.effect）
 * 10 URI / 哈希 / 区域码 / uuid / date-time 格式非法
 * 11 required 且 nullable 的字段必须出现（缺 = 拒；显式 null = 过）
 * 12 additionalProperties:false（多余字段）
 * 13 数组 minItems / maxItems
 * 14 revision 不一致（If-Match 不匹配）
 * 15 If-Match 缺失 → 428
 * 16 If-Match 格式非法 → 400
 * 17 路径 id 非 uuid
 * 18 Idempotency-Key 缺失 → IDEMPOTENCY_KEY_REQUIRED；长度非法 → INVALID_REQUEST
 * 19 分页 limit 超上限 / 非整数
 * 20 cursor 超长 → 400；cursor 伪造/串家族/集合已变 → INVALID_CURSOR
 * 21 request_id 非 uuid
 * 22 发布门槛在发布时复检（库中内容不合契约）→ 拒 + denied 审计 + 不得部分发布
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  FAMILY_CASES,
  OTHER_STEWARD,
  adminIdentity,
  context,
  createDraft,
  createHarness,
  expectApiError,
  idempotencyKey,
  publishRevision,
  validKnowledgeInput,
  validPublishBody,
  validRegistrationInput,
  validRestrictionInput,
  validSourceInput,
  validWithdrawBody,
} from './admin-fixtures.mjs';

const SOURCES = FAMILY_CASES[0];
const KNOWLEDGE = FAMILY_CASES[1];
const REGISTRATIONS = FAMILY_CASES[2];
const RESTRICTIONS = FAMILY_CASES[3];

/** 断言 ApiError 的 details 形状（字段级证据）。 */
function assertFieldDetails(error) {
  assert.equal(Array.isArray(error.details), true, 'details 必须是数组');
  assert.ok(error.details.length >= 1, 'details 不得为空');
  for (const detail of error.details) {
    assert.equal(typeof detail.field, 'string');
    assert.equal(typeof detail.code, 'string');
    assert.notEqual(detail.field, '');
  }
}

test('反例 1/2：非 admin 与缺写 scope 的操作一律 SCOPE_DENIED', async () => {
  const { service } = createHarness();
  const readOnlyAdmin = { identity: adminIdentity({ scopes: ['sources:read'] }) };
  const auditOnlyAdmin = { identity: adminIdentity({ scopes: ['audit:read'] }) };
  const userCtx = { identity: { userId: OTHER_STEWARD, authEpoch: 1, role: 'user', scopes: ['user'] } };

  // 正控制：完整 scope 的 admin 可以读。
  assert.equal((await service.listAdminSources(context())).status, 200);

  for (const [label, ctx, allowed] of [
    ['仅读 scope', readOnlyAdmin, ['listAdminSources']],
    ['仅审计 scope', auditOnlyAdmin, ['listAuditEvents']],
    ['用户会话', userCtx, []],
  ]) {
    if (!allowed.includes('createSourceDraft')) {
      await expectApiError(() => service.createSourceDraft(ctx, validSourceInput()), 'SCOPE_DENIED');
    }
    if (!allowed.includes('listAuditEvents')) {
      await expectApiError(() => service.listAuditEvents(ctx), 'SCOPE_DENIED');
    }
    assert.equal(typeof label, 'string');
  }
  // 仅读 scope 的 admin 仍然可以读。
  assert.equal((await service.listAdminSources(readOnlyAdmin)).status, 200);
  // 仅审计 scope 的 admin 读资料来源被拒。
  await expectApiError(() => service.listAdminSources(auditOnlyAdmin), 'SCOPE_DENIED');
  // 审计 scope 的 admin 可以读审计。
  assert.equal((await service.listAuditEvents(auditOnlyAdmin)).status, 200);

  // 身份字段缺失/非法：与 auth/middleware.ts 的 readIdentity 语义一致。
  await expectApiError(() => service.listAdminSources({}), 'SESSION_REQUIRED');
  await expectApiError(() => service.listAdminSources({ identity: adminIdentity({ userId: '' }) }), 'SESSION_REQUIRED');
  await expectApiError(() => service.listAdminSources({ identity: adminIdentity({ authEpoch: null }) }), 'SESSION_REQUIRED');
  await expectApiError(() => service.listAdminSources({ identity: adminIdentity({ authEpoch: 0 }) }), 'INVALID_REQUEST');
  await expectApiError(() => service.listAdminSources({ identity: adminIdentity({ role: 'root' }) }), 'SESSION_REQUIRED');
});

test('反例 3/4：越权目标与跨家族 id 与「不存在」对外完全同形', async () => {
  const { service } = createHarness();
  const created = await createDraft(SOURCES, service);
  const id = created.body.data.id;
  await publishRevision(SOURCES, service, id, 1);

  const otherAdmin = { identity: adminIdentity({ userId: OTHER_STEWARD }) };
  const absentId = randomUUID();

  const shapes = [];
  for (const call of [
    () => service.getAdminSource(otherAdmin, id),
    () => service.publishSource({ ...otherAdmin, idempotencyKey: idempotencyKey('x'), ifMatch: '"1"' }, id, validPublishBody()),
    () => service.editSourceDraft({ ...otherAdmin, idempotencyKey: idempotencyKey('x'), ifMatch: '"1"' }, id, SOURCES.editedInput()),
    () => service.withdrawSource({ ...otherAdmin, idempotencyKey: idempotencyKey('x'), ifMatch: '"1"' }, id, validWithdrawBody()),
    () => service.getAdminSource(otherAdmin, absentId),
    () => service.getAdminSource(context(), absentId),
  ]) {
    const error = await expectApiError(call, 'NOT_FOUND');
    assert.equal(error.status, 404);
    shapes.push(`${error.status}|${error.code}|${error.message}`);
  }
  // 「越权」「跨主体」「不存在」对外必须**完全同形**（否则就是目标探测通道）。
  assert.equal(new Set(shapes).size, 1, `对外形状不一致：${JSON.stringify([...new Set(shapes)])}`);

  // 跨家族 id：用 knowledge 的 id 调 sources 接口也必须 NOT_FOUND。
  const knowledgeDraft = await createDraft(KNOWLEDGE, service);
  await expectApiError(() => service.getAdminSource(context(), knowledgeDraft.body.data.id), 'NOT_FOUND');
  await expectApiError(() => service.getAdminKnowledge(context(), id), 'NOT_FOUND');

  // 管辖隔离：他人列表里看不到本主体的资料。
  const others = await service.listAdminSources(otherAdmin);
  assert.deepStrictEqual(others.body.data.items, []);
  const mine = await service.listAdminSources(context());
  assert.equal(mine.body.data.items.length, 1);
});

test('反例 5：编辑不得改写已发布正文，只能追加新的草稿修订', async () => {
  for (const caseEntry of FAMILY_CASES) {
    const { service, store, view } = createHarness();
    const family = caseEntry.descriptor.family;
    const originalInput = caseEntry.contentInput();
    const snapshot = structuredClone(originalInput);
    const created = await createDraft(caseEntry, service, context(), originalInput);
    const id = created.body.data.id;
    await publishRevision(caseEntry, service, id, 1);

    const edited = await caseEntry.ops(service).edit(
      { ...context(), idempotencyKey: idempotencyKey(`${caseEntry.name}-edit`), ifMatch: '"1"' },
      id,
      caseEntry.editedInput(),
    );
    assert.equal(edited.body.data.revision, 2);

    // 依据：契约把 `revision` 作为资源修订号，且 `If-Match` 是按修订号的强 ETag；
    // 一个"已发布修订"要改正文，契约里唯一可表达的方式就是产生**新修订**。
    const entity = store.getEntity(id);
    assert.deepStrictEqual(entity.revisions[0].content, snapshot, `${caseEntry.name} 的已发布修订被改写了`);
    assert.equal(entity.publishedRevision, 1, '发布指针不得因编辑而前移');
    assert.equal(entity.lifecycle, 'published', '编辑不得把已发布状态改掉');
    assert.deepStrictEqual(view.readPublished(family, id).content, snapshot, '公开读必须仍是旧已发布修订');
  }
});

test('反例 6/7/8：发布体必填缺失、超长、正文超长一律 INVALID_REQUEST', async () => {
  const { service } = createHarness();
  const created = await createDraft(SOURCES, service);
  const id = created.body.data.id;

  const publishWith = (body) => service.publishSource(
    { ...context(), idempotencyKey: idempotencyKey('p'), ifMatch: '"1"' },
    id,
    body,
  );

  // 正控制：合法发布体可以发布。
  assert.equal((await publishWith(validPublishBody())).status, 200);

  const badBodies = [
    {},                                            // 两个必填全缺
    { reason: 'r' },                               // 缺 evidence_ref
    { evidence_ref: 'E' },                         // 缺 reason
    { evidence_ref: '', reason: 'r' },             // minLength 违规
    { evidence_ref: 'E', reason: '' },
    { evidence_ref: 'E'.repeat(81), reason: 'r' }, // evidence_ref 超长
    { evidence_ref: 'E', reason: 'r'.repeat(501) },// reason 超长
    { evidence_ref: ['E'], reason: 'r' },          // 类型错
    { evidence_ref: 'E', reason: 'r', extra: 1 },  // additionalProperties:false
  ];
  for (const body of badBodies) {
    const error = await expectApiError(() => publishWith(body), 'INVALID_REQUEST');
    assertFieldDetails(error);
  }
  // 超长正文（编辑入参）：title 201 / body 20001
  await expectApiError(
    () => KNOWLEDGE.ops(service).create(
      { ...context(), idempotencyKey: idempotencyKey('k') },
      validKnowledgeInput({ title: '题'.repeat(201) }),
    ),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => KNOWLEDGE.ops(service).create(
      { ...context(), idempotencyKey: idempotencyKey('k') },
      validKnowledgeInput({ body: '正'.repeat(20001) }),
    ),
    'INVALID_REQUEST',
  );
});

test('反例 9：闭集外枚举一律 INVALID_REQUEST（三类资料各一例）', async () => {
  const { service } = createHarness();
  await expectApiError(
    () => SOURCES.ops(service).create({ ...context(), idempotencyKey: idempotencyKey('s') }, validSourceInput({ source_kind: 'guessed' })),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => SOURCES.ops(service).create({ ...context(), idempotencyKey: idempotencyKey('s') }, validSourceInput({ evidence_kind: 'tradition' })),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => KNOWLEDGE.ops(service).create({ ...context(), idempotencyKey: idempotencyKey('k') }, validKnowledgeInput({ type: 'pesticide' })),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => RESTRICTIONS.ops(service).create({ ...context(), idempotencyKey: idempotencyKey('r') }, validRestrictionInput({ effect: 'allowed' })),
    'INVALID_REQUEST',
  );
});

test('反例 10：URI / 哈希 / 区域码 / uuid / date-time 格式非法一律 INVALID_REQUEST', async () => {
  const { service } = createHarness();
  const createSource = (patch) => SOURCES.ops(service).create({ ...context(), idempotencyKey: idempotencyKey('s') }, validSourceInput(patch));

  // 正控制：合法值可以建草稿。
  assert.equal((await createSource({})).status, 201);

  const badSources = [
    { url: 'http://example.invalid/x' },                    // 非 https
    { url: 'not-a-uri' },                                   // 非 uri
    { url: 'https://[invalid' },                            // URL 解析失败
    { content_hash: 'a'.repeat(63) },                       // 长度不足
    { content_hash: 'A'.repeat(64) },                       // 大写不在 [a-f0-9]
    { content_hash: `${'a'.repeat(64)}z` },
    { valid_from: '2026-09-01' },                           // date-time 格式
    { valid_from: '2026-13-40T00:00:00Z' },
    { valid_to: 'yesterday' },
  ];
  for (const patch of badSources) {
    const error = await expectApiError(() => createSource(patch), 'INVALID_REQUEST');
    assertFieldDetails(error);
  }

  await expectApiError(
    () => KNOWLEDGE.ops(service).create(
      { ...context(), idempotencyKey: idempotencyKey('k') },
      validKnowledgeInput({ source_id: 'not-a-uuid' }),
    ),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => RESTRICTIONS.ops(service).create(
      { ...context(), idempotencyKey: idempotencyKey('r') },
      validRestrictionInput({ conditions: { crop_id: 'rice', region_code: '33010' } }),
    ),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => RESTRICTIONS.ops(service).create(
      { ...context(), idempotencyKey: idempotencyKey('r') },
      validRestrictionInput({ conditions: { crop_id: 'rice', region_code: '440100' } }),
    ),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => REGISTRATIONS.ops(service).create(
      { ...context(), idempotencyKey: idempotencyKey('g') },
      validRegistrationInput({ formulation: { registration_number: 'X', producer: 'Y', dosage_form: 'Z', ingredients: [{ name: 'n', content_text: 'c', unit_text: 'u' }] , bad: 1 } }),
    ),
    'INVALID_REQUEST',
  );
});

test('反例 11：required 且 nullable 的字段必须出现（缺 = 拒，显式 null = 过）', async () => {
  const { service } = createHarness();
  // 显式 null 是契约允许的（anyOf [T, null]）。
  const withNull = validSourceInput({ valid_to: null });
  assert.equal((await SOURCES.ops(service).create({ ...context(), idempotencyKey: idempotencyKey('s') }, withNull)).status, 201);

  // 省略该键 ⇒ required 违规。
  const missingKey = validSourceInput();
  delete missingKey.valid_to;
  await expectApiError(
    () => SOURCES.ops(service).create({ ...context(), idempotencyKey: idempotencyKey('s') }, missingKey),
    'INVALID_REQUEST',
  );

  // knowledge.conditions 是 required 且 nullable：省略要拒，null 要过。
  const knowledgeMissingConditions = validKnowledgeInput();
  delete knowledgeMissingConditions.conditions;
  await expectApiError(
    () => KNOWLEDGE.ops(service).create({ ...context(), idempotencyKey: idempotencyKey('k') }, knowledgeMissingConditions),
    'INVALID_REQUEST',
  );
  assert.equal(
    (await KNOWLEDGE.ops(service).create({ ...context(), idempotencyKey: idempotencyKey('k') }, validKnowledgeInput({ conditions: null }))).status,
    201,
  );

  // restrictions.conditions 是 required 且**不可空** ⇒ 显式 null 也要拒。
  await expectApiError(
    () => RESTRICTIONS.ops(service).create({ ...context(), idempotencyKey: idempotencyKey('r') }, validRestrictionInput({ conditions: null })),
    'INVALID_REQUEST',
  );
});

test('反例 12/13：additionalProperties:false 与数组 minItems/maxItems', async () => {
  const { service } = createHarness();
  await expectApiError(
    () => SOURCES.ops(service).create({ ...context(), idempotencyKey: idempotencyKey('s') }, validSourceInput({ unexpected: 1 })),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => KNOWLEDGE.ops(service).create({ ...context(), idempotencyKey: idempotencyKey('k') }, { ...validKnowledgeInput(), dose: '10ml' }),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => RESTRICTIONS.ops(service).create(
      { ...context(), idempotencyKey: idempotencyKey('r') },
      validRestrictionInput({ conditions: { crop_id: 'rice', region_code: '330100', dose: '10ml' } }),
    ),
    'INVALID_REQUEST',
  );
  const formulation = (ingredients) => ({ registration_number: 'PD1', producer: 'P', dosage_form: 'D', ingredients });
  await expectApiError(
    () => REGISTRATIONS.ops(service).create(
      { ...context(), idempotencyKey: idempotencyKey('g') },
      validRegistrationInput({ formulation: formulation([]) }),
    ),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => REGISTRATIONS.ops(service).create(
      { ...context(), idempotencyKey: idempotencyKey('g') },
      validRegistrationInput({
        formulation: formulation(Array.from({ length: 21 }, (unused, index) => ({ name: `n${index}`, content_text: 'c', unit_text: 'u' }))),
      }),
    ),
    'INVALID_REQUEST',
  );
  // 正控制：恰好 20 项可以过。
  assert.equal(
    (await REGISTRATIONS.ops(service).create(
      { ...context(), idempotencyKey: idempotencyKey('g') },
      validRegistrationInput({
        formulation: formulation(Array.from({ length: 20 }, (unused, index) => ({ name: `n${index}`, content_text: 'c', unit_text: 'u' }))),
      }),
    )).status,
    201,
  );
});

test('反例 14/15/16：revision 不一致 409、If-Match 缺失 428、格式非法 400', async () => {
  for (const caseEntry of FAMILY_CASES) {
    const { service, store } = createHarness();
    const created = await createDraft(caseEntry, service);
    const id = created.body.data.id;
    const ops = caseEntry.ops(service);
    const key = () => idempotencyKey(`${caseEntry.name}-p`);

    // 缺失 ⇒ 428 REVISION_REQUIRED
    const missing = await expectApiError(
      () => ops.publish({ ...context(), idempotencyKey: key() }, id, validPublishBody()),
      'REVISION_REQUIRED',
    );
    assert.equal(missing.status, 428);

    // 格式非法 ⇒ 400
    for (const ifMatch of ['*', 'W/"1"', '"0"', '1', '"1', '1"', '"01"', '"99999999999999999999999"', 'abc']) {
      const malformed = await expectApiError(
        () => ops.publish({ ...context(), idempotencyKey: key(), ifMatch }, id, validPublishBody()),
        'INVALID_REQUEST',
      );
      assert.equal(malformed.status, 400);
      assertFieldDetails(malformed);
    }

    // revision 不一致 ⇒ 409 REVISION_CONFLICT（且不得部分发布）
    const stale = await expectApiError(
      () => ops.publish({ ...context(), idempotencyKey: key(), ifMatch: '"7"' }, id, validPublishBody()),
      'REVISION_CONFLICT',
    );
    assert.equal(stale.status, 409);
    assert.equal(store.getEntity(id).publishedRevision, null, 'revision 不一致时绝不允许已发布');
    assert.equal(store.getEntity(id).lifecycle, 'draft');

    // 正控制：匹配的 If-Match 可以发布。
    assert.equal((await publishRevision(caseEntry, service, id, 1)).status, 200);
    // 已发布后用**格式合法但陈旧**的 ETag 再发布 ⇒ 409（revision 不一致）。
    const staleAfterPublish = await expectApiError(
      () => ops.publish({ ...context(), idempotencyKey: key(), ifMatch: '"9"' }, id, validPublishBody()),
      'REVISION_CONFLICT',
    );
    assert.equal(staleAfterPublish.status, 409);
  }
});

test('反例 17：路径 id 非 uuid ⇒ INVALID_REQUEST', async () => {
  const { service } = createHarness();
  for (const bad of ['', 'abc', '123', `${randomUUID()}x`, randomUUID().replace(/-/g, '_')]) {
    await expectApiError(() => service.getAdminSource(context(), bad), 'INVALID_REQUEST');
    await expectApiError(() => service.getAdminKnowledge(context(), bad), 'INVALID_REQUEST');
  }
  // 正控制：合法 uuid 走 NOT_FOUND 而不是 400；uuid 大小写不敏感。
  await expectApiError(() => service.getAdminSource(context(), randomUUID()), 'NOT_FOUND');
  await expectApiError(() => service.getAdminSource(context(), randomUUID().toUpperCase()), 'NOT_FOUND');
});

test('反例 18：Idempotency-Key 缺失 / 长度非法', async () => {
  const { service } = createHarness();
  await expectApiError(
    () => service.createSourceDraft({ ...context(), idempotencyKey: undefined }, validSourceInput()),
    'IDEMPOTENCY_KEY_REQUIRED',
  );
  await expectApiError(
    () => service.createSourceDraft({ ...context(), idempotencyKey: '' }, validSourceInput()),
    'IDEMPOTENCY_KEY_REQUIRED',
  );
  for (const bad of ['short', 'x'.repeat(129)]) {
    await expectApiError(
      () => service.createSourceDraft({ ...context(), idempotencyKey: bad }, validSourceInput()),
      'INVALID_REQUEST',
    );
  }
  // 正控制：8 字符边界可以过。
  assert.equal(
    (await service.createSourceDraft({ ...context(), idempotencyKey: '12345678' }, validSourceInput())).status,
    201,
  );
  assert.equal(
    (await service.createSourceDraft({ ...context(), idempotencyKey: 'x'.repeat(128) }, validSourceInput())).status,
    201,
  );
});

test('反例 19/20：分页 limit 与 cursor', async () => {
  const { service } = createHarness();
  // 建 3 条 sources。
  for (let index = 0; index < 3; index += 1) await createDraft(SOURCES, service);

  for (const limit of [0, 51, -1, 1.5, 'abc', [20], {}]) {
    await expectApiError(() => service.listAdminSources({ ...context() }, { limit }), 'INVALID_REQUEST');
  }
  // 正控制：1..50 与字符串数字都合法。
  assert.equal((await service.listAdminSources(context(), { limit: 1 })).body.data.items.length, 1);
  assert.equal((await service.listAdminSources(context(), { limit: '2' })).body.data.items.length, 2);
  assert.equal((await service.listAdminSources(context(), { limit: 50 })).body.data.items.length, 3);
  assert.equal((await service.listAdminSources(context())).body.data.items.length, 3, '缺省 limit 为 20');

  const longCursor = 'x'.repeat(2049);
  await expectApiError(() => service.listAdminSources(context(), { cursor: longCursor }), 'INVALID_REQUEST');
  for (const cursor of ['abc', 'a.b', '.', `${'x'.repeat(100)}.y`, `${'a'.repeat(10)}.${'b'.repeat(10)}`]) {
    await expectApiError(() => service.listAdminSources(context(), { cursor }), 'INVALID_CURSOR');
  }

  // 真游标：limit=1 拿到 next_cursor。
  const first = await service.listAdminSources(context(), { limit: 1 });
  const next = first.body.data.next_cursor;
  assert.equal(typeof next, 'string');
  const dot = next.indexOf('.');
  const bodyPart = next.slice(0, dot);
  const signaturePart = next.slice(dot + 1);
  // 改载荷首字符 ⇒ 签名失效（改签名末字符可能落在 base64 未使用位上，故改载荷更确定）。
  const tamperedBody = `${bodyPart[0] === 'A' ? 'B' : 'A'}${bodyPart.slice(1)}`;
  await expectApiError(() => service.listAdminSources(context(), { cursor: `${tamperedBody}.${signaturePart}` }), 'INVALID_CURSOR');
  // 改签名首字符 ⇒ 签名失效（首字符 6 位全部有效）。
  const tamperedSignature = `${signaturePart[0] === 'A' ? 'B' : 'A'}${signaturePart.slice(1)}`;
  await expectApiError(() => service.listAdminSources(context(), { cursor: `${bodyPart}.${tamperedSignature}` }), 'INVALID_CURSOR');
  // 串家族使用 ⇒ INVALID_CURSOR。
  await expectApiError(() => service.listAdminKnowledge(context(), { cursor: next }), 'INVALID_CURSOR');
  // 正控制：同一个游标能继续翻页；游标只绑定「上一页最后一条」，不锁死 page size。
  const second = await service.listAdminSources(context(), { cursor: next });
  assert.equal(second.body.data.items.length, 2, '首页 limit=1 之后，剩余两条应一次读完');
  assert.equal(second.body.data.next_cursor, null);
  const firstIds = first.body.data.items.map((item) => item.id);
  const secondIds = second.body.data.items.map((item) => item.id);
  assert.deepStrictEqual(firstIds.filter((id) => secondIds.includes(id)), [], '翻页不得重复返回同一条');
  // 集合变化后旧游标失效（watermark 绑定）。
  await createDraft(SOURCES, service);
  await expectApiError(() => service.listAdminSources(context(), { cursor: next }), 'INVALID_CURSOR');
});

test('反例 21：request_id 非 uuid ⇒ INVALID_REQUEST', async () => {
  const { service } = createHarness();
  await expectApiError(() => service.listAdminSources({ ...context(), requestId: 'not-a-uuid' }), 'INVALID_REQUEST');
  // 正控制：合法 uuid 被原样回填到 Meta。
  const requestId = randomUUID();
  const response = await service.listAdminSources({ ...context(), requestId });
  assert.equal(response.body.meta.request_id, requestId);
  assert.equal(response.body.meta.contract_version, '1.0.0');
  assert.equal(response.body.meta.execution_mode, 'stub');
});

test('反例 22：发布门槛在发布时复检库中内容；拒绝时不得部分发布', async () => {
  const { service, store, view, clock } = createHarness();
  const created = await createDraft(SOURCES, service);
  const id = created.body.data.id;
  const entity = store.getEntity(id);
  const authorId = context().identity.userId;

  // 绕过写入路径把非法内容放进库里（模拟历史数据/迁移/未来改线）：
  // 通过**追加一条不合契约的修订**注入，而不是改写既有修订——
  // 既有修订在存储边界已被深冻结（返修 1），本来就改不动。
  // 这不是"没校验就放行"而是"没校验 = 不可发布"：发布时必须重新判定。
  const before = structuredClone(entity.revisions[0].content);
  store.appendRevision({
    entity,
    content: { ...before, title: '' },
    authorId,
    createdAt: clock.now(),
    derivedFromRevision: 1,
  });
  assert.equal(entity.revisions.length, 2);
  assert.throws(() => {
    entity.revisions[1].content.title = '改不动';
  }, TypeError);

  const error = await expectApiError(
    () => publishRevision(SOURCES, service, id, 2),
    'INVALID_REQUEST',
  );
  assertFieldDetails(error);

  // 不得部分发布：状态完全不变。
  assert.equal(entity.publishedRevision, null);
  assert.equal(entity.lifecycle, 'draft');
  assert.equal(entity.publishedAt, null);
  assert.equal(view.readPublished('sources', id), null);

  // 拒绝也要留痕：恰好一条 result='denied' 的审计，且带目标 revision。
  const events = (await service.listAuditEvents(context())).body.data.items;
  assert.equal(events.length, 1);
  assert.equal(events[0].result, 'denied');
  assert.equal(events[0].action, 'source.publish');
  assert.equal(events[0].target_ref.revision, 2);
  assert.ok(events[0].reason_code.startsWith('publish_gate_denied:'));

  // 追加一条合法修订后可以发布，且这次是 accepted。
  store.appendRevision({
    entity,
    content: before,
    authorId,
    createdAt: clock.now(),
    derivedFromRevision: 2,
  });
  await publishRevision(SOURCES, service, id, 3);
  const after = (await service.listAuditEvents(context())).body.data.items;
  assert.deepStrictEqual(after.map((event) => event.result), ['denied', 'accepted']);
  assert.notEqual(view.readPublished('sources', id), null);
  assert.equal(view.readPublished('sources', id).revision, 3);
});
