/**
 * GY-I14 模型层（第二片）· **失败隔离矩阵**（派单 §4 硬性验收条件）。
 *
 * 每个用例都是**独立**反例：可单独指出"哪一类失败、落哪个 decision、留哪个可判别原因"。
 * 三条共同纪律：
 *   1) `decision !== 'approved'`（"没跑"／"没结论"／"跑挂了"都不等于通过）；
 *   2) 必须留下**可判别**的模型层原因码（不是一句笼统的"失败了"）；
 *   3) 合流不变式不得被违反（`checkMergedInvariant` 为空）。
 *
 * 真实 `tms`/`ims` 一律不调：全部端口都是 `provider.synthetic === true` 的合成替身。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AUDIT_STATES } from '../../packages/moderation/constants.mjs';

import { checkMergedInvariant, mergeModeration } from '../../packages/moderation/merge.mjs';
import { MODEL_REASON_CODES } from '../../packages/moderation/model-reason-codes.mjs';
import {
  CLEAN_RULE_RESULT,
  INVALID_INPUT_RULE_RESULT,
  MEDIA_RULE_RESULT,
  PRIVACY_TEXT,
  REJECTED_RULE_RESULT,
  blockVerdict,
  makeContent,
  makeMediaContent,
  makePort,
  modelFailureError,
  neverResolvingPort,
  passVerdict,
  portThrowing,
  runRules,
} from './_model-fixtures.mjs';

function expectNotApproved(merged, name) {
  assert.equal(typeof merged.decision, 'string', `${name}: decision 必须是字符串`);
  assert.equal(AUDIT_STATES.includes(merged.decision), true, `${name}: decision 越界`);
  assert.notEqual(merged.decision, 'approved', `${name}: 不得判为通过`);
  const invariant = checkMergedInvariant(merged);
  assert.deepEqual(invariant.violations, [], `${name}: 违反合流不变式`);
}

function expectModelCode(merged, code, name) {
  assert.equal(typeof code, 'string');
  assert.equal(MODEL_REASON_CODES.includes(code), true, `${name}: ${code} 不在模型层闭集`);
  assert.equal(merged.reason_codes.includes(code), true, `${name}: 缺可判别原因 ${code}（实际 ${merged.reason_codes.join(',')}）`);
}

// ---------------------------------------------------------------------------
// 1) 接线类失败
// ---------------------------------------------------------------------------

test('失败隔离：缺文本端口 ⇒ quarantined + MODEL_LAYER_PORT_MISSING（未接线不得通过）', async () => {
  const merged = await mergeModeration(CLEAN_RULE_RESULT, { content: makeContent() });
  expectNotApproved(merged, '缺端口');
  expectModelCode(merged, 'MODEL_LAYER_PORT_MISSING', '缺端口');
  assert.equal(merged.decision, 'quarantined');
  assert.equal(merged.model_layer.kinds.tms.status, 'not_invoked', '没端口就没跑，不得声称求值过');
  assert.equal(merged.model_layer.kinds.tms.label, null);
});

test('失败隔离：带媒体且缺图片端口 ⇒ 不得通过（规则层码与模型层码同时可见）', async () => {
  const merged = await mergeModeration(MEDIA_RULE_RESULT, {
    content: makeMediaContent(),
    ports: { tms: makePort() },
  });
  expectNotApproved(merged, '缺图片端口');
  expectModelCode(merged, 'MODEL_LAYER_PORT_MISSING', '缺图片端口');
  assert.equal(merged.reason_codes.includes('MEDIA_NOT_EVALUATED_BY_RULE_LAYER'), true);
  assert.equal(merged.model_layer.kinds.ims.status, 'not_invoked');
  assert.equal(merged.model_layer.kinds.tms.status, 'pass', '文本端口照常求值，互不影响');
});

test('失败隔离：端口 evaluate 不是函数 ⇒ MODEL_LAYER_PORT_INVALID', async () => {
  const port = makePort();
  port.evaluate = 'not-a-function';
  const merged = await mergeModeration(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: port } });
  expectNotApproved(merged, 'evaluate 非函数');
  expectModelCode(merged, 'MODEL_LAYER_PORT_INVALID', 'evaluate 非函数');
});

test('失败隔离：provider 缺 biz_type 声明 ⇒ MODEL_LAYER_PORT_INVALID', async () => {
  const port = makePort();
  delete port.provider.biz_type;
  const merged = await mergeModeration(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: port } });
  expectNotApproved(merged, 'provider 缺字段');
  expectModelCode(merged, 'MODEL_LAYER_PORT_INVALID', 'provider 缺字段');
});

test('失败隔离：BizType 未核验（占位值）⇒ MODEL_BIZTYPE_UNVERIFIED，且**根本不调用**端口', async () => {
  let calls = 0;
  const port = makePort({
    provider: { biz_type_selection_verified: false },
    evaluate: () => {
      calls += 1;
      return passVerdict();
    },
  });
  const merged = await mergeModeration(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: port } });
  expectNotApproved(merged, 'BizType 未核验');
  expectModelCode(merged, 'MODEL_BIZTYPE_UNVERIFIED', 'BizType 未核验');
  assert.equal(calls, 0, '未核验的 BizType 一律不发请求（真实 tms/ims 未被调用）');
  assert.equal(merged.model_layer.kinds.tms.status, 'not_invoked');
});

test('失败隔离：端口未回报合法 model_version ⇒ MODEL_VERSION_MISSING，且**不填占位串**', async () => {
  const merged = await mergeModeration(CLEAN_RULE_RESULT, {
    content: makeContent(),
    ports: { tms: makePort({ model_version: '' }) },
  });
  expectNotApproved(merged, '模型版本缺失');
  expectModelCode(merged, 'MODEL_VERSION_MISSING', '模型版本缺失');
  assert.equal(merged.model_version, null);
  assert.equal(merged.contract_value, null, '缺必填字段不得装配契约对象');
  assert.equal(merged.missing_contract_fields.includes('model_version'), true);
  for (const placeholder of ['unknown', 'tbd', 'n/a', 'pending']) {
    assert.notEqual(merged.model_version, placeholder);
  }
});

// ---------------------------------------------------------------------------
// 2) 运行期失败（超时／配额／鉴权／载荷／形状／抛错／未求值）
// ---------------------------------------------------------------------------

const FAILURE_CASES = [
  {
    name: '模型超时（端口抛 TimeoutError）',
    code: 'MODEL_TIMEOUT',
    port: () => portThrowing(Object.assign(new Error('synthetic timeout'), { name: 'TimeoutError' })),
  },
  {
    name: '模型超时（端口永不返回，合流层 deadline 触发）',
    code: 'MODEL_TIMEOUT',
    port: () => neverResolvingPort(),
    options: { deadline_ms: 1 },
  },
  {
    name: '配额耗尽（HTTP 429）',
    code: 'MODEL_QUOTA_EXCEEDED',
    port: () => portThrowing(Object.assign(new Error('synthetic quota'), { http_status: 429 })),
  },
  {
    name: '配额耗尽（显式声明 model_failure=quota_exceeded）',
    code: 'MODEL_QUOTA_EXCEEDED',
    port: () => portThrowing(modelFailureError('quota_exceeded')),
  },
  {
    name: '鉴权失败（HTTP 401）',
    code: 'MODEL_AUTH_FAILED',
    port: () => portThrowing(Object.assign(new Error('synthetic auth'), { status: 401 })),
  },
  {
    name: '鉴权失败（HTTP 403）',
    code: 'MODEL_AUTH_FAILED',
    port: () => portThrowing(Object.assign(new Error('synthetic forbidden'), { statusCode: 403 })),
  },
  {
    name: '载荷非法（端口判定请求载荷非法）',
    code: 'MODEL_PAYLOAD_INVALID',
    port: () => portThrowing(modelFailureError('payload_invalid')),
  },
  {
    name: '载荷非法（HTTP 400）',
    code: 'MODEL_PAYLOAD_INVALID',
    port: () => portThrowing(Object.assign(new Error('synthetic bad request'), { http_status: 400 })),
  },
  {
    name: '未知响应形状（返回 null）',
    code: 'MODEL_RESPONSE_SHAPE_UNKNOWN',
    port: () => makePort({ evaluate: () => null }),
  },
  {
    name: '未知响应形状（缺 label）',
    code: 'MODEL_RESPONSE_SHAPE_UNKNOWN',
    port: () => makePort({ evaluate: () => ({ reason_codes: [], summary: 'x' }) }),
  },
  {
    name: '未知响应形状（label 不在闭集）',
    code: 'MODEL_RESPONSE_SHAPE_UNKNOWN',
    port: () => makePort({ evaluate: () => ({ label: 'maybe', reason_codes: [], summary: 'x' }) }),
  },
  {
    name: '未知响应形状（回报的 model_version 与端口声明不一致）',
    code: 'MODEL_RESPONSE_SHAPE_UNKNOWN',
    port: () => makePort({ evaluate: () => passVerdict({ model_version: 'another-model@9' }) }),
  },
  {
    name: '端口抛错（无法归类的未知异常）',
    code: 'MODEL_PORT_ERROR',
    port: () => portThrowing(new Error('synthetic unknown explosion')),
  },
  {
    name: '模型 unsure（没结论 ⇒ 不是通过）',
    code: 'MODEL_NOT_EVALUATED',
    port: () => makePort({ evaluate: () => passVerdict({ label: 'unsure' }) }),
  },
];

for (const item of FAILURE_CASES) {
  test(`失败隔离：${item.name} ⇒ 不得 approved`, async () => {
    const port = item.port();
    const merged = await mergeModeration(CLEAN_RULE_RESULT, {
      content: makeContent(),
      ports: { tms: port },
      ...(item.options ?? {}),
    });
    expectNotApproved(merged, item.name);
    expectModelCode(merged, item.code, item.name);
    assert.equal(merged.model_layer.kinds.tms.status === 'pass', false, `${item.name}: 不得声称该端口通过`);
  });
}

test('失败隔离：媒体描述符非法（夹带 bytes）⇒ MODEL_PAYLOAD_INVALID，不传字节', async () => {
  const content = makeMediaContent({
    media: [{ media_id: '22222222-2222-4222-8222-222222222222', media_revision: 1, mime: 'image/png', bytes: 2048 }],
  });
  const ruleResult = runRules(content);
  const merged = await mergeModeration(ruleResult, {
    content,
    ports: { tms: makePort(), ims: makePort({ kind: 'ims' }) },
  });
  expectNotApproved(merged, '媒体描述符夹带 bytes');
  expectModelCode(merged, 'MODEL_PAYLOAD_INVALID', '媒体描述符夹带 bytes');
  assert.equal(merged.model_layer.kinds.ims.status, 'not_invoked', '载荷非法时不得调用图片端口');
});

test('失败隔离：非图片媒体（video/mp4）⇒ MODEL_MEDIA_UNSUPPORTED（本片只承担图片）', async () => {
  const content = makeMediaContent({
    media: [{ media_id: '44444444-4444-4444-8444-444444444444', media_revision: 1, mime: 'video/mp4' }],
  });
  const ruleResult = runRules(content);
  const merged = await mergeModeration(ruleResult, {
    content,
    ports: { tms: makePort(), ims: makePort({ kind: 'ims' }) },
  });
  expectNotApproved(merged, '非图片媒体');
  expectModelCode(merged, 'MODEL_MEDIA_UNSUPPORTED', '非图片媒体');
});

test('失败隔离：两个 kind 回报不同模型标识 ⇒ MODEL_VERSION_CONFLICT（契约只有一个 model_version 字段）', async () => {
  const merged = await mergeModeration(MEDIA_RULE_RESULT, {
    content: makeMediaContent(),
    ports: {
      tms: makePort({ model_version: 'synthetic-tms-model@1.0' }),
      ims: makePort({ kind: 'ims', model_version: 'synthetic-ims-model@2.0' }),
    },
  });
  expectNotApproved(merged, '模型版本冲突');
  expectModelCode(merged, 'MODEL_VERSION_CONFLICT', '模型版本冲突');
  assert.equal(merged.model_version, null, '无法表达时不得二选一硬填');
});

// ---------------------------------------------------------------------------
// 3) 规则层结论不得被模型翻案（两个方向）
// ---------------------------------------------------------------------------

test('不得翻案：规则层 rejected + 模型通过 ⇒ 仍 rejected，规则层原因码保留', async () => {
  assert.equal(REJECTED_RULE_RESULT.decision, 'rejected', '夹具前提：规则层判驳回');
  const merged = await mergeModeration(REJECTED_RULE_RESULT, {
    content: makeContent({ text: PRIVACY_TEXT }),
    ports: { tms: makePort() },
  });
  assert.equal(merged.decision, 'rejected');
  assert.equal(merged.hard_rule_passed, false);
  assert.equal(merged.reason_codes.includes('PRIVACY_PII'), true);
  assert.equal(merged.model_layer.kinds.tms.status, 'pass', '模型确实通过了，但不得翻案');
});

test('不得翻案：规则层 quarantined + 模型通过 ⇒ 仍 quarantined', async () => {
  assert.equal(MEDIA_RULE_RESULT.decision, 'quarantined', '夹具前提：规则层隔离（带媒体）');
  const merged = await mergeModeration(MEDIA_RULE_RESULT, {
    content: makeMediaContent(),
    ports: { tms: makePort(), ims: makePort({ kind: 'ims' }) },
  });
  assert.equal(merged.decision, 'quarantined');
  assert.equal(merged.reason_codes.includes('MEDIA_NOT_EVALUATED_BY_RULE_LAYER'), true);
});

test('带媒体 + 图片端口通过 ⇒ 仍不得 approved（硬规则一条都没跑，"没跑"≠"通过"）', async () => {
  const merged = await mergeModeration(MEDIA_RULE_RESULT, {
    content: makeMediaContent(),
    ports: { tms: makePort(), ims: makePort({ kind: 'ims' }) },
  });
  expectNotApproved(merged, '媒体目标 + 双端口通过');
  assert.equal(merged.hard_rule_passed, false);
  assert.equal(merged.model_layer.kinds.tms.status, 'pass');
  assert.equal(merged.model_layer.kinds.ims.status, 'pass');
  // 口径记录：图片端口只补证据，不得把 quarantined 抬成 approved（否则等于"没跑硬规则却通过"）。
  assert.equal(merged.rule_layer.decision, 'quarantined');
});

test('不得翻案：模型 block 只降不升 ⇒ rejected（不是 approved）', async () => {
  const merged = await mergeModeration(CLEAN_RULE_RESULT, {
    content: makeContent(),
    ports: { tms: makePort({ evaluate: () => blockVerdict() }) },
  });
  assert.equal(merged.decision, 'rejected');
  expectModelCode(merged, 'MODEL_BLOCKED', '模型 block');
  assert.equal(merged.hard_rule_passed, true, 'hard_rule_passed 只反映规则层事实，模型不得改写它');
});

test('hard_rule_passed 只反映规则层：规则通过 + 模型失败 ⇒ hard=true 但 decision=quarantined', async () => {
  const merged = await mergeModeration(CLEAN_RULE_RESULT, {
    content: makeContent(),
    ports: { tms: portThrowing(modelFailureError('timeout')) },
  });
  assert.equal(merged.hard_rule_passed, true, '规则层事实为真，不得被模型结论改写');
  assert.equal(merged.decision, 'quarantined');
  assert.equal(merged.reason_codes.includes('MODEL_TIMEOUT'), true);
  // 这正是合流层不变式与规则层不变式的**口径差异**：合流层只有单向必要条件。
  assert.equal(checkMergedInvariant(merged).ok, true);
});

// ---------------------------------------------------------------------------
// 4) 输入类失败
// ---------------------------------------------------------------------------

test('失败隔离：输入闸门不通过（空文本）⇒ 模型层不尝试，且不追加模型层噪音码', async () => {
  const merged = await mergeModeration(INVALID_INPUT_RULE_RESULT, {
    content: { ...makeContent({ text: '   ' }) },
    ports: { tms: makePort() },
  });
  expectNotApproved(merged, '输入闸门不通过');
  assert.equal(merged.model_layer.status, 'not_attempted');
  assert.deepEqual(merged.model_layer.reason_codes, []);
  assert.equal(merged.reason_codes.some((code) => MODEL_REASON_CODES.includes(code)), false);
  assert.equal(merged.reason_codes.includes('INPUT_TEXT_EMPTY'), true);
});

test('失败隔离：content 与规则层看到的输入不一致 ⇒ MODEL_MERGE_INPUT_INVALID 且隔离', async () => {
  const cases = [
    ['target_ref 不一致', { ...makeContent(), target_ref: { type: 'post', id: 'other-id', revision: 1 } }],
    ['text 为空', { ...makeContent(), text: '' }],
    ['media 数量不一致', { ...makeContent(), media: [{ media_id: 'x' }] }],
  ];
  for (const [name, content] of cases) {
    const merged = await mergeModeration(CLEAN_RULE_RESULT, { content, ports: { tms: makePort() } });
    expectNotApproved(merged, name);
    expectModelCode(merged, 'MODEL_MERGE_INPUT_INVALID', name);
    assert.equal(merged.decision, 'quarantined');
  }
});

test('失败隔离：非法 execution_mode ⇒ MODEL_MERGE_INPUT_INVALID（"选项给错"≠"按默认跑一遍就算过"）', async () => {
  const merged = await mergeModeration(CLEAN_RULE_RESULT, {
    content: makeContent(),
    ports: { tms: makePort() },
    execution_mode: 'production',
  });
  expectNotApproved(merged, '非法执行模式');
  expectModelCode(merged, 'MODEL_MERGE_INPUT_INVALID', '非法执行模式');
});

test('失败隔离：规则层结果自相矛盾（approved 但 hard_rule_passed 非真）⇒ 拒', async () => {
  const tampered = { ...CLEAN_RULE_RESULT, hard_rule_passed: false };
  const merged = await mergeModeration(tampered, { content: makeContent(), ports: { tms: makePort() } });
  expectNotApproved(merged, '规则层结果自相矛盾');
  expectModelCode(merged, 'MODEL_MERGE_INPUT_INVALID', '规则层结果自相矛盾');
});

test('失败隔离：规则层冒充模型层字段 ⇒ MODEL_LAYER_FIELD_SPOOFED，且绝不采信其值', async () => {
  const tampered = {
    ...CLEAN_RULE_RESULT,
    model_version: 'spoofed-by-rule-layer',
    prompt_version: 'spoofed-by-rule-layer',
  };
  const merged = await mergeModeration(tampered, { content: makeContent(), ports: { tms: makePort() } });
  expectNotApproved(merged, '规则层冒充模型层字段');
  expectModelCode(merged, 'MODEL_LAYER_FIELD_SPOOFED', '规则层冒充模型层字段');
  assert.notEqual(merged.model_version, 'spoofed-by-rule-layer');
  assert.equal(merged.model_version, 'synthetic-tms-model@1.0', '只采信注入端口回报的模型标识');
  assert.notEqual(merged.prompt_version, 'spoofed-by-rule-layer');
  assert.deepEqual(merged.model_layer.declaration.spoofed_fields, ['model_version', 'prompt_version']);
});

test('矩阵总表：全部失败路径的 decision 都落在闭集内且都不是 approved', async () => {
  const mergedList = [
    await mergeModeration(CLEAN_RULE_RESULT, { content: makeContent() }),
    await mergeModeration(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: portThrowing(modelFailureError('timeout')) } }),
    await mergeModeration(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: makePort({ evaluate: () => null }) } }),
    await mergeModeration(MEDIA_RULE_RESULT, { content: makeMediaContent() }),
    await mergeModeration(INVALID_INPUT_RULE_RESULT, { content: makeContent({ text: '   ' }) }),
  ];
  for (const merged of mergedList) {
    assert.equal(typeof merged.decision, 'string');
    assert.equal(AUDIT_STATES.includes(merged.decision), true);
    assert.notEqual(merged.decision, 'approved');
    assert.deepEqual(checkMergedInvariant(merged).violations, []);
  }
});
