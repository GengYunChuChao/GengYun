/**
 * GY-I14（#14）审核 HTTP 装配片 · **版本级任务 / 规则先挡 / 失败隔离 / real fail-closed**。
 *
 * 声明（必须如实）：全部输入是**合成夹具**、全部模型端口是**合成替身**（不发网络请求、无凭据）；
 * 真实 `tms`/`ims` 未授权付费，本文件**不调**任何真实供应商；本文件**不得**被引用为准确率证据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBoundHardRules, moderationInputDigest } from '../../packages/moderation/input-binding.mjs';
import { RULE_VERSION } from '../../packages/moderation/index.mjs';
import { collectResultValueIssues } from '../../services/api/src/jobs/result-shape.ts';
import { buildErrorEnvelope } from '../../services/api/src/errors.ts';
import {
  ADMIN,
  CLEAN_TEXT,
  RULE_TEXT_FIXTURES,
  USER_A,
  blockVerdict,
  buildScanLimitText,
  captureError,
  countingPort,
  makeHarness,
  mediaContent,
  modelFailureError,
  neverResolvingPort,
  portThrowing,
  textContent,
} from './_http-fixtures.mjs';

const MODERATION_CONTRACT_KEYS = [
  'id',
  'target_ref',
  'decision',
  'reason_codes',
  'hard_rule_passed',
  'model_version',
  'prompt_version',
  'rule_version',
];

test('版本级任务：文字内容生成一条 text 任务，登记结构结果/理由/证据/模型模板/规则版本（合成替身）', async () => {
  const tms = countingPort('tms');
  const h = makeHarness({ ports: { tms: tms.port } });
  const content = textContent();
  const out = await h.service.submitScreening({ actor: USER_A, content });

  assert.equal(out.tasks.length, 1, '文字内容只需一条版本级任务');
  const task = out.tasks[0];
  assert.equal(task.content_kind, 'text');
  assert.equal(task.port_kind, 'tms');
  assert.equal(task.prompt_id, 'text_moderation');
  assert.equal(task.decision, 'approved');
  assert.equal(task.state, 'succeeded');
  assert.equal(task.hard_rule_passed, true);
  assert.equal(task.error_code, null);
  assert.equal(task.superseded, false);
  assert.equal(task.job_revision, 1);
  assert.equal(tms.calls.count, 1, '规则层通过后模型端口被求值一次');

  // 结构结果：契约合法（键集合恰好 8 个、闭集、上界），且 id 与作业同源
  assert.deepEqual(Object.keys(task.contract_value).sort(), [...MODERATION_CONTRACT_KEYS].sort());
  assert.deepEqual(collectResultValueIssues('moderation', task.contract_value), []);
  assert.equal(task.contract_value.id, task.job_id);
  assert.equal(task.contract_value.decision, 'approved');
  assert.deepEqual(task.contract_value.target_ref, content.target_ref);

  // 版本登记：规则版本由当前规则集派生、prompt 版本由模板内容派生、模型版本来自端口声明
  assert.equal(task.rule_version, RULE_VERSION);
  assert.equal(task.model_version, tms.model_version);
  assert.match(String(task.prompt_version), /^mp1\+sha256:[0-9a-f]{32}$/);
  assert.equal(task.evidence.model_template, 'text_moderation');
  assert.equal(task.evidence.execution_mode, 'stub');
  assert.equal(task.evidence.provider.kind, 'tms');
  assert.equal(task.evidence.provider.synthetic, true);
  assert.equal(task.evidence.provider.origin, 'injected');
  assert.deepEqual(task.evidence.rule_reason_codes, []);
  assert.deepEqual(task.evidence.model_reason_codes, []);
  assert.deepEqual(task.evidence.model_kinds.map((entry) => [entry.kind, entry.status]), [['tms', 'pass']]);
  assert.equal(task.evidence.media_count, 0);
  assert.deepEqual(task.evidence.checked_media_refs, []);

  // 证据：结论绑定**它实际检查过的内容**（摘要与输入绑定），且**不落原文**
  assert.equal(task.evidence.input_binding_verified, true);
  assert.equal(task.evidence.input_binding_digest, moderationInputDigest(content));
  assert.match(String(task.evidence.input_binding_digest), /^mib1\+sha256:[0-9a-f]{32}$/);
  assert.equal(task.evidence.text_length, content.text.length);
  assert.equal(JSON.stringify(task).includes(CLEAN_TEXT), false, '审核记录不得抄录正文原文');

  // 与规则层基线一致（同一份夹具：合成端口 pass 时结论只能是 approved）
  const ruleBaseline = evaluateBoundHardRules(
    { target_ref: content.target_ref, text: content.text, media: [] },
    { clock: () => 0, budget_ms: 5000 },
  );
  assert.equal(ruleBaseline.decision, 'approved');
  assert.equal(ruleBaseline.rule_version, task.rule_version);

  assert.equal(out.overall.decision, 'approved');
  assert.equal(out.overall.publishable, true, '筛查通过是"可发布"的必要条件');
});

test('版本级任务：带图片内容生成 text + image 两条任务；按已合并规则层口径带媒体一律不得判通过', async () => {
  const tms = countingPort('tms');
  const ims = countingPort('ims', { model_version: 'synthetic-ims-model@2.0' });
  const h = makeHarness({ ports: { tms: tms.port, ims: ims.port } });
  const content = mediaContent();
  const out = await h.service.submitScreening({ actor: USER_A, content });

  assert.equal(out.tasks.length, 2, '文字与图片各自成版本级任务');
  assert.deepEqual(out.tasks.map((task) => task.content_kind), ['text', 'image']);
  assert.notEqual(out.tasks[0].job_id, out.tasks[1].job_id, '两条任务各有独立 job_id（结论行独立）');
  assert.deepEqual(out.tasks.map((task) => task.port_kind), ['tms', 'ims']);
  assert.deepEqual(out.tasks.map((task) => task.prompt_id), ['text_moderation', 'image_moderation']);

  // 规则层对带媒体目标一律不判通过（`MEDIA_NOT_EVALUATED_BY_RULE_LAYER`）⇒ 结论只能是隔离
  for (const task of out.tasks) {
    assert.equal(task.decision, 'quarantined');
    assert.equal(task.state, 'uncertain');
    assert.notEqual(task.decision, 'approved');
    assert.ok(task.reason_codes.includes('MEDIA_NOT_EVALUATED_BY_RULE_LAYER'), '媒体未由规则层评估必须显式登记');
    assert.equal(task.hard_rule_passed, false);
    assert.equal(task.error_code, 'INPUT_UNCERTAIN');
  }

  // 图片端口**确实被求值并登记证据**（版本级任务成立），但证据不得把结论抬成通过
  assert.equal(tms.calls.count, 1);
  assert.equal(ims.calls.count, 1);
  const image = out.tasks[1];
  assert.equal(image.evidence.provider.kind, 'ims');
  assert.deepEqual(
    image.evidence.model_kinds.map((entry) => [entry.kind, entry.status]),
    [
      ['tms', 'pass'],
      ['ims', 'pass'],
    ],
  );
  assert.deepEqual(image.evidence.checked_media_refs, [`${content.media[0].media_id}:1`]);

  // 两个 kind 回报不同模型版本 ⇒ 契约只有一个 model_version 字段，无法表达 ⇒ 不装配契约对象（绝不填占位）
  assert.ok(image.reason_codes.includes('MODEL_VERSION_CONFLICT'));
  assert.equal(image.contract_value, null);
  assert.equal(out.overall.publishable, false);
});

test('规则先挡：广告导流/私交易/硬危险/危险混配/无依据用量/隐私/提示注入一律先在规则层驳回，模型端口不跑', async () => {
  // 覆盖面自证：出厂夹具必须覆盖派单点名的全部类别
  const categories = new Set(RULE_TEXT_FIXTURES.map((fixture) => fixture.category));
  for (const required of [
    'dangerous_usage',
    'label_bound_dose',
    'privacy',
    'prompt_injection',
    'authority_spoofing',
    'safety_claim',
    'commerce',
  ]) {
    assert.ok(categories.has(required), `规则夹具必须覆盖类别 ${required}`);
  }
  const reasonCodes = new Set(RULE_TEXT_FIXTURES.map((fixture) => fixture.reason_code));
  for (const required of [
    'DANGEROUS_MIX',
    'DOSE_UNBOUNDED',
    'DOSE_NOT_BOUND_TO_LABEL',
    'PRIVACY_PII',
    'PRIVACY_COORDS',
    'PROMPT_INJECTION',
    'COMMERCE_SOLICITATION',
    'COMMERCE_LINK',
  ]) {
    assert.ok(reasonCodes.has(required), `规则夹具必须覆盖原因码 ${required}`);
  }

  let index = 0;
  for (const fixture of RULE_TEXT_FIXTURES) {
    index += 1;
    const tms = countingPort('tms');
    const h = makeHarness({ ports: { tms: tms.port } });
    const target = { type: 'post', id: `post-hit-${index}`, revision: 1 };
    const hit = await h.service.submitScreening({ actor: USER_A, content: textContent({ text: fixture.hit, target_ref: target }) });
    assert.equal(hit.tasks[0].decision, 'rejected', `${fixture.rule_id} 命中必须被驳回`);
    assert.equal(hit.tasks[0].state, 'succeeded');
    assert.ok(
      hit.tasks[0].reason_codes.includes(fixture.reason_code),
      `${fixture.rule_id} 结论必须带原因码 ${fixture.reason_code}`,
    );
    assert.equal(tms.calls.count, 0, `${fixture.rule_id} 规则先挡：模型端口不得被调用（也不得外发违规/含 PII 内容）`);

    const miss = await h.service.submitScreening({
      actor: USER_A,
      content: textContent({ text: fixture.miss, target_ref: { type: 'post', id: `post-miss-${index}`, revision: 1 } }),
    });
    assert.notEqual(miss.tasks[0].decision, 'rejected', `${fixture.rule_id} 反向夹具不得被误拦`);
  }
});

test('失败隔离：超时 / 配额 / 无结论 / 形状未知 / 明确不通过 —— 逐条可判别，且绝不记通过', async () => {
  // ① 端口超时（合流层自己的 deadline 闸门）
  {
    const h = makeHarness({ ports: { tms: neverResolvingPort({ kind: 'tms' }) }, modelDeadlineMs: 20 });
    const out = await h.service.submitScreening({ actor: USER_A, content: textContent() });
    const task = out.tasks[0];
    assert.equal(task.decision, 'quarantined');
    assert.equal(task.state, 'uncertain');
    assert.ok(task.reason_codes.includes('MODEL_TIMEOUT'), task.reason_codes.join(','));
    assert.equal(task.error_code, 'PROVIDER_TIMEOUT');
    // 隔离结论**能被契约表达**（model/prompt 版本齐备）⇒ 调用方读得到"未通过 + 原因码"，
    // 但它**不是**通过：`decision !== 'approved'`，且发布闸门另行拒绝。
    assert.equal(task.contract_value.decision, 'quarantined');
    assert.deepEqual(task.contract_value.reason_codes, ['MODEL_TIMEOUT']);
    assert.notEqual(task.decision, 'approved');
  }
  // ② 配额/鉴权类失败（端口抛错）
  {
    const h = makeHarness({ ports: { tms: portThrowing(modelFailureError('quota_exceeded'), { kind: 'tms' }) } });
    const out = await h.service.submitScreening({ actor: USER_A, content: textContent() });
    assert.equal(out.tasks[0].decision, 'quarantined');
    assert.equal(out.tasks[0].state, 'uncertain');
    assert.ok(out.tasks[0].reason_codes.includes('MODEL_QUOTA_EXCEEDED'));
    assert.equal(out.tasks[0].error_code, 'PROVIDER_OUTCOME_UNKNOWN');
  }
  // ③ 无结论（unsure）
  {
    const tms = countingPort('tms', { evaluate: () => ({ label: 'unsure', reason_codes: [], summary: 'no conclusion' }) });
    const h = makeHarness({ ports: { tms: tms.port } });
    const out = await h.service.submitScreening({ actor: USER_A, content: textContent() });
    assert.equal(out.tasks[0].decision, 'quarantined');
    assert.ok(out.tasks[0].reason_codes.includes('MODEL_NOT_EVALUATED'));
    assert.equal(out.tasks[0].evidence.model_kinds[0].status, 'failed');
  }
  // ④ 回报形状未知（缺 prompt 声明的必报字段）
  {
    const tms = countingPort('tms', { evaluate: () => ({ label: 'pass' }) });
    const h = makeHarness({ ports: { tms: tms.port } });
    const out = await h.service.submitScreening({ actor: USER_A, content: textContent() });
    assert.equal(out.tasks[0].decision, 'quarantined');
    assert.ok(out.tasks[0].reason_codes.includes('MODEL_RESPONSE_SHAPE_UNKNOWN'));
  }
  // ⑤ 端口明确判定不通过 ⇒ rejected（不得升级为 approved）
  {
    const tms = countingPort('tms', { evaluate: () => blockVerdict() });
    const h = makeHarness({ ports: { tms: tms.port } });
    const out = await h.service.submitScreening({ actor: USER_A, content: textContent() });
    assert.equal(out.tasks[0].decision, 'rejected');
    assert.equal(out.tasks[0].state, 'succeeded');
    assert.ok(out.tasks[0].reason_codes.includes('MODEL_BLOCKED'));
  }
  // ⑥ 缺端口（不注入任何端口）⇒ 替身，且**替身只回报无结论 ⇒ 隔离、绝不放行**
  {
    const h = makeHarness();
    const out = await h.service.submitScreening({ actor: USER_A, content: textContent() });
    assert.equal(out.tasks[0].decision, 'quarantined');
    assert.equal(out.tasks[0].state, 'uncertain');
    assert.equal(out.tasks[0].evidence.provider.origin, 'substitute');
    assert.equal(out.tasks[0].evidence.provider.synthetic, true);
    assert.match(String(out.tasks[0].model_version), /^synthetic-substitute-/);
    assert.ok(out.tasks[0].reason_codes.includes('MODEL_NOT_EVALUATED'));
    assert.deepEqual(h.service.counts().substitutes, ['tms', 'ims']);
    assert.equal(out.overall.publishable, false, '替身不得放行任何内容');
  }
});

test('输入不可用 / 规则集非法 / 扫描限额耗尽：一律隔离且不通过（fail-closed 闸门在装配层同样生效）', async () => {
  // ① 空正文 ⇒ 规则层输入闸门不通过
  const tms = countingPort('tms');
  const h = makeHarness({ ports: { tms: tms.port } });
  const empty = await h.service.submitScreening({ actor: USER_A, content: textContent({ text: '   ' }) });
  assert.equal(empty.tasks[0].decision, 'quarantined');
  assert.equal(empty.tasks[0].state, 'uncertain');
  assert.notEqual(empty.tasks[0].decision, 'approved');
  assert.equal(tms.calls.count, 0, '输入不可用时不得调用模型端口');

  // ② 非法规则集（引擎自检失败）⇒ 隔离，绝不通过，且不调用端口
  const badPort = countingPort('tms');
  const bad = makeHarness({ ports: { tms: badPort.port }, ruleOptions: { rules: [{ id: 'BROKEN-RULE' }] } });
  const brokenCatalog = await bad.service.submitScreening({ actor: USER_A, content: textContent() });
  assert.equal(brokenCatalog.tasks[0].decision, 'quarantined');
  assert.ok(brokenCatalog.tasks[0].reason_codes.includes('RULE_CATALOG_INVALID'), brokenCatalog.tasks[0].reason_codes.join(','));
  assert.equal(badPort.calls.count, 0);

  // ③ 匹配器扫描限额耗尽（未检查 ≠ 干净）⇒ 隔离 + 可判别原因码
  const limitPort = countingPort('tms');
  const limit = makeHarness({ ports: { tms: limitPort.port } });
  const truncated = await limit.service.submitScreening({
    actor: USER_A,
    content: textContent({ text: buildScanLimitText(64) }),
  });
  assert.equal(truncated.tasks[0].decision, 'quarantined');
  assert.ok(truncated.tasks[0].reason_codes.includes('RULE_SCAN_TRUNCATED'), truncated.tasks[0].reason_codes.join(','));
  assert.equal(truncated.tasks[0].error_code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(limitPort.calls.count, 0, '规则层未得出可放行结论时不得调用模型端口');
});

test('real 未接真实供应商：整域 fail-closed 503 PROVIDER_UNAVAILABLE（retryable），且不产出任何任务', async () => {
  const tms = countingPort('tms');
  const h = makeHarness({ executionMode: 'real', ports: { tms: tms.port } });
  const content = textContent();

  const refused = [];
  for (const run of [
    () => h.service.submitScreening({ actor: USER_A, content }),
    () => h.service.runModelScreening({ actor: USER_A, content }),
    () => h.service.publish({ actor: USER_A, content }),
    () => h.service.withdraw({ actor: ADMIN, target_ref: content.target_ref, reason_code: 'synthetic-takedown' }),
    () => h.service.readView({ actor: USER_A, target_ref: content.target_ref }),
    () => h.service.reReview({ actor: USER_A, target_ref: content.target_ref }),
    () => h.service.ingestCallback({ raw_body: '{}', signature: 'x' }),
  ]) {
    const error = await captureError(run);
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE', String(error.message));
    assert.equal(error.status, 503);
    assert.equal(error.retryable, false, '未接线能力（需运维接线后才可用）不是瞬时故障：同一请求原样重试不会成功 ⇒ 不得标 retryable');
    refused.push(error);
  }
  assert.equal(tms.calls.count, 0, 'real 不得调用任何注入端口（也不得静默回退替身）');
  assert.equal(h.service.counts().tasks, 0, '不得以内存/替身记录"已完成"的审核任务');
  assert.deepEqual(h.service.tasks(content.target_ref), []);
  assert.equal(h.service.taskByJobId('00000000-0000-4000-8500-000000000001'), null);
  assert.equal(h.service.execution_mode, 'real');

  // 契约 503 封套（HTTP 传输层形态；本片不新增路由，故这里直接核对共享错误封套）
  const envelope = buildErrorEnvelope(refused[0], { request_id: 'synthetic-request-id', execution_mode: 'real' });
  assert.equal(envelope.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(envelope.error.retryable, false);
  assert.deepEqual(envelope.error.details, []);
  assert.equal(envelope.meta.execution_mode, 'real');
  assert.equal(envelope.meta.contract_version, '1.0.0');
});

test('stub 对照：同一路径在 stub 下可跑通并如实标注替身/合成端口，但结论绝不冒充真实供应商', async () => {
  const tms = countingPort('tms');
  const h = makeHarness({ executionMode: 'stub', ports: { tms: tms.port } });
  const out = await h.service.submitScreening({ actor: USER_A, content: textContent() });
  assert.equal(out.tasks[0].evidence.execution_mode, 'stub');
  assert.equal(out.tasks[0].evidence.provider.synthetic, true);
  assert.equal(out.tasks[0].evidence.provider.biz_type, 'synthetic-biz-placeholder');
  assert.equal(h.service.counts().authority_origin, 'substitute');
  assert.equal(h.service.counts().callback_key_configured, true);
  assert.equal(h.service.execution_mode, 'stub');
});
