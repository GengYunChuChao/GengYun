/**
 * GY-I22（#22）失败回归矩阵 · **服务端受信 seam** 用例族（D 族）。
 *
 * 为什么单独一族：审核回调、模型端口失败、下架失效都不是客户端契约路径
 * （ADR-001 §62：供应商 callback 不开放给客户端；模型端口是服务端注入项），
 * 但它们恰恰是「看起来通过了、实际没把关」最容易出事的地方。这一族用**同一张用例表**
 * 的判定口径（id + 期望错误码 + 实际 + PASS/FAIL），只是把「一次 HTTP 请求」换成
 * 「一次受信 seam 调用」。
 *
 * 声明（必须如实）：
 *   - 全部模型/供应商端口都是**合成替身**（`provider.synthetic === true`），不发任何网络请求、
 *     不持有凭据、不读环境变量；真实 tms/ims 未授权，本片一律不调（记入「未取得」）。
 *   - 回调验签密钥是测试常量 `gy-i14-http-test-callback-key`，不是真实密钥。
 *   - 本族**不**证明审核准确率/召回率，只证明**失败路径与越权路径一律 fail-closed**。
 *
 * 一条用例的形状：
 *   { id, family, title, expect: { code }, invoke(): Promise<{ code, detail }>, check?(detail) }
 * 判定：`detail.code === expect.code` 且 `check()` 无问题 ⇒ PASS。
 */
import {
  ADMIN,
  USER_A,
  captureError,
  countingPort,
  envelopeForTask,
  makeHarness,
  makePort,
  neverResolvingPort,
  passVerdict,
  portThrowing,
  seedAuthority,
  signedCallback,
  textContent,
} from '../moderation/_http-fixtures.mjs';
import { PRIVACY_TEXT } from '../moderation/_model-fixtures.mjs';
import { signCallbackPayload } from '../../services/api/src/moderation/callback.ts';

export const SEAM_FAMILIES = Object.freeze({
  D1: '审核回调（重复/旧版本/下架/授权撤回 ⇒ 拒绝；回调绝不发布）',
  D2: 'AI 失败/超时/结构错误/规则未过 ⇒ 一律不得发布',
  D3: '下架 ⇒ 读缓存失效 + 可见性转 hidden',
  D4: '版本回写：内容改版后旧审核结论不得复用，历史版本不得发布',
});

/** 建一个「待回调」的版本级任务（异步供应商路径：模型层未求值）。 */
async function queued(options = {}) {
  const tms = countingPort('tms', options.portOptions ?? {});
  const h = makeHarness({ ports: { tms: tms.port } });
  const content = options.content ?? textContent();
  const res = await h.service.submitScreening({ actor: USER_A, content, defer_model: true });
  return { h, tms, content, task: res.tasks[0], res };
}

/** 回调结果的紧凑投影（只保留判定要用的字段）。 */
function callbackView(outcome) {
  return {
    code: outcome.accepted ? 'OK' : (outcome.reason_codes[0] ?? 'CALLBACK_NO_REASON_CODE'),
    accepted: outcome.accepted,
    reason_codes: [...outcome.reason_codes],
    contract_error_code: outcome.contract_error_code,
    task_state: outcome.task?.state ?? null,
    task_decision: outcome.task?.decision ?? null,
  };
}

/** 筛查任务的紧凑投影。 */
function screeningView(res) {
  const task = res.tasks[0] ?? {};
  return {
    code: task.error_code ?? (res.overall?.decision === 'approved' ? 'OK' : 'SCREENING_NOT_APPROVED'),
    task_state: task.state ?? null,
    task_decision: task.decision ?? null,
    task_error_code: task.error_code ?? null,
    task_reason_codes: [...(task.reason_codes ?? [])],
    publishable: res.overall?.publishable ?? null,
    overall_decision: res.overall?.decision ?? null,
    overall_reason_codes: [...(res.overall?.reason_codes ?? [])],
    hard_rule_passed: task.hard_rule_passed ?? null,
  };
}

export const SEAM_CASES = Object.freeze([
  // ---------------------------------------------------------------- D1 审核回调
  {
    id: 'D1-01',
    family: 'D1',
    title: '重复回调（同一 event_id 第二次）⇒ CALLBACK_REPLAY，且首条已落定为 approved',
    expect: { code: 'CALLBACK_REPLAY' },
    async invoke() {
      const { h, task } = await queued();
      const env = envelopeForTask(task, { event_id: 'evt-d1-01' });
      const first = await h.service.ingestCallback(signedCallback(env));
      const second = await h.service.ingestCallback(signedCallback(env));
      return {
        code: second.accepted ? 'OK' : (second.reason_codes[0] ?? 'CALLBACK_NO_REASON_CODE'),
        detail: {
          first_accepted: first.accepted,
          first_decision: first.task?.decision ?? null,
          second_reason_codes: [...second.reason_codes],
          second_contract_error_code: second.contract_error_code,
          settled_events: h.service.counts().callback_settled ?? null,
        },
      };
    },
    check(detail) {
      const problems = [];
      if (detail.first_accepted !== true) problems.push('首次回调本应被接受（否则「回放」无从谈起）');
      if (detail.first_decision !== 'approved') problems.push(`首次回调应落定 approved，实际 ${detail.first_decision}`);
      if (detail.second_contract_error_code !== 'IDEMPOTENCY_CONFLICT') {
        problems.push(`回放应映射 IDEMPOTENCY_CONFLICT(409)，实际 ${detail.second_contract_error_code}`);
      }
      return problems;
    },
  },
  {
    id: 'D1-02',
    family: 'D1',
    title: '任务已终态后旧回调（换 event_id）⇒ CALLBACK_JOB_TERMINAL，旧回调不复活',
    expect: { code: 'CALLBACK_JOB_TERMINAL' },
    async invoke() {
      const { h, task } = await queued();
      await h.service.ingestCallback(signedCallback(envelopeForTask(task, { event_id: 'evt-d1-02a' })));
      const later = await h.service.ingestCallback(signedCallback(envelopeForTask(task, { event_id: 'evt-d1-02b' })));
      return { code: later.accepted ? 'OK' : (later.reason_codes[0] ?? 'CALLBACK_NO_REASON_CODE'), detail: callbackView(later) };
    },
    check(detail) {
      const problems = [];
      if (detail.contract_error_code !== 'OBJECT_UNAVAILABLE') {
        problems.push(`终态回调应映射 OBJECT_UNAVAILABLE(409)，实际 ${detail.contract_error_code}`);
      }
      if (detail.task_state !== null) problems.push('被拒的回调不得返回任务投影');
      return problems;
    },
  },
  {
    id: 'D1-03',
    family: 'D1',
    title: '目标已下架后的回调 ⇒ CALLBACK_TARGET_WITHDRAWN（下架对象不得被旧回调复活）',
    expect: { code: 'CALLBACK_TARGET_WITHDRAWN' },
    async invoke() {
      const h = makeHarness({ ports: { tms: makePort({ kind: 'tms', evaluate: () => passVerdict() }) } });
      const content = textContent();
      seedAuthority(h.authority, content.target_ref, { owner_id: USER_A.userId });
      await h.service.submitScreening({ actor: USER_A, content });
      const published = await h.service.publish({ actor: USER_A, content });
      const withdrawn = await h.service.withdraw({ actor: ADMIN, target_ref: content.target_ref, reason_code: 'policy' });
      const after = await h.service.submitScreening({ actor: USER_A, content, defer_model: true });
      const task = after.tasks[0];
      const callback = await h.service.ingestCallback(signedCallback(envelopeForTask(task, { event_id: 'evt-d1-03' })));
      return {
        code: callback.accepted ? 'OK' : (callback.reason_codes[0] ?? 'CALLBACK_NO_REASON_CODE'),
        detail: {
          published: published.published,
          withdrawn: withdrawn.withdrawn,
          withdraw_keys: [...withdrawn.invalidated_cache_keys],
          queued_task_state: task.state,
          callback: callbackView(callback),
        },
      };
    },
    check(detail) {
      const problems = [];
      if (detail.published !== true) problems.push('前置：下架前必须先真发布成功');
      if (detail.queued_task_state !== 'queued') problems.push(`前置：下架后新任务应在 queued，实际 ${detail.queued_task_state}`);
      if (detail.callback.contract_error_code !== 'OBJECT_UNAVAILABLE') {
        problems.push(`下架回调应映射 OBJECT_UNAVAILABLE(409)，实际 ${detail.callback.contract_error_code}`);
      }
      return problems;
    },
  },
  {
    id: 'D1-04',
    family: 'D1',
    title: '旧 job_revision 回调 ⇒ CALLBACK_JOB_REVISION_STALE',
    expect: { code: 'CALLBACK_JOB_REVISION_STALE' },
    async invoke() {
      const { h, task } = await queued();
      const env = envelopeForTask(task, { event_id: 'evt-d1-04', job_revision: task.job_revision + 1 });
      const outcome = await h.service.ingestCallback(signedCallback(env));
      return { code: outcome.accepted ? 'OK' : (outcome.reason_codes[0] ?? 'CALLBACK_NO_REASON_CODE'), detail: callbackView(outcome) };
    },
    check(detail) {
      const problems = [];
      if (detail.contract_error_code !== 'REVISION_CONFLICT') {
        problems.push(`版本过期应映射 REVISION_CONFLICT(409)，实际 ${detail.contract_error_code}`);
      }
      return problems;
    },
  },
  {
    id: 'D1-05',
    family: 'D1',
    title: '旧 lease_token 回调 ⇒ CALLBACK_LEASE_MISMATCH',
    expect: { code: 'CALLBACK_LEASE_MISMATCH' },
    async invoke() {
      const { h, task } = await queued();
      const env = envelopeForTask(task, { event_id: 'evt-d1-05', lease_token: 'lease-9999' });
      const outcome = await h.service.ingestCallback(signedCallback(env));
      return { code: outcome.accepted ? 'OK' : (outcome.reason_codes[0] ?? 'CALLBACK_NO_REASON_CODE'), detail: callbackView(outcome) };
    },
    check(detail) {
      return detail.contract_error_code === 'INVALID_REQUEST'
        ? []
        : [`租约不符应映射 INVALID_REQUEST(400)，实际 ${detail.contract_error_code}`];
    },
  },
  {
    id: 'D1-06',
    family: 'D1',
    title: '换内容不换版本（input_digest 与任务登记不一致）⇒ CALLBACK_INPUT_DIGEST_MISMATCH',
    expect: { code: 'CALLBACK_INPUT_DIGEST_MISMATCH' },
    async invoke() {
      const { h, task } = await queued();
      const env = envelopeForTask(task, { event_id: 'evt-d1-06', input_digest: `mib1+sha256:${'f'.repeat(32)}` });
      const outcome = await h.service.ingestCallback(signedCallback(env));
      return { code: outcome.accepted ? 'OK' : (outcome.reason_codes[0] ?? 'CALLBACK_NO_REASON_CODE'), detail: callbackView(outcome) };
    },
    check(detail) {
      return detail.contract_error_code === 'REVISION_CONFLICT'
        ? []
        : [`摘要不符应映射 REVISION_CONFLICT(409)（换内容不换版本必须拒），实际 ${detail.contract_error_code}`];
    },
  },
  {
    id: 'D1-07',
    family: 'D1',
    title: '过期回调（签发时间越出 ±5min）⇒ CALLBACK_EXPIRED',
    expect: { code: 'CALLBACK_EXPIRED' },
    async invoke() {
      const { h, task } = await queued();
      const env = envelopeForTask(task, { event_id: 'evt-d1-07', issued_at: '2020-01-01T00:00:00.000Z' });
      const outcome = await h.service.ingestCallback(signedCallback(env));
      return { code: outcome.accepted ? 'OK' : (outcome.reason_codes[0] ?? 'CALLBACK_NO_REASON_CODE'), detail: callbackView(outcome) };
    },
    check(detail) {
      return detail.contract_error_code === 'INVALID_REQUEST'
        ? []
        : [`过期回调应映射 INVALID_REQUEST(400)，实际 ${detail.contract_error_code}`];
    },
  },
  {
    id: 'D1-08',
    family: 'D1',
    title: '伪造/篡改签名 ⇒ CALLBACK_SIGNATURE_INVALID（不是「未授权 200」）',
    expect: { code: 'CALLBACK_SIGNATURE_INVALID' },
    async invoke() {
      const { h, task } = await queued();
      const env = envelopeForTask(task, { event_id: 'evt-d1-08' });
      const raw = JSON.stringify(env);
      const outcome = await h.service.ingestCallback({ raw_body: raw, signature: signCallbackPayload(raw, 'wrong-key') });
      const missing = await h.service.ingestCallback({ raw_body: raw, signature: '' });
      return {
        code: outcome.accepted ? 'OK' : (outcome.reason_codes[0] ?? 'CALLBACK_NO_REASON_CODE'),
        detail: { ...callbackView(outcome), missing_signature_codes: [...missing.reason_codes] },
      };
    },
    check(detail) {
      const problems = [];
      if (detail.contract_error_code !== 'SCOPE_DENIED') {
        problems.push(`验签失败应映射 SCOPE_DENIED(403)，实际 ${detail.contract_error_code}`);
      }
      if (detail.missing_signature_codes[0] !== 'CALLBACK_SIGNATURE_INVALID') {
        problems.push(`空签名也必须按 CALLBACK_SIGNATURE_INVALID 拒绝，实际 ${JSON.stringify(detail.missing_signature_codes)}`);
      }
      return problems;
    },
  },
  {
    id: 'D1-09',
    family: 'D1',
    title: '回调里塞控制类字段（role）⇒ CALLBACK_CONTROL_FIELD_FORBIDDEN（非绕过）',
    expect: { code: 'CALLBACK_CONTROL_FIELD_FORBIDDEN' },
    async invoke() {
      const { h, task } = await queued();
      // `envelopeForTask` 只认已知字段，未知键会被丢弃 ⇒ 必须直接往信封对象上塞。
      const env = { ...envelopeForTask(task, { event_id: 'evt-d1-09' }), role: 'admin' };
      const outcome = await h.service.ingestCallback(signedCallback(env));
      return { code: outcome.accepted ? 'OK' : (outcome.reason_codes[0] ?? 'CALLBACK_NO_REASON_CODE'), detail: callbackView(outcome) };
    },
    check(detail) {
      return detail.contract_error_code === 'INVALID_REQUEST'
        ? []
        : [`控制字段应映射 INVALID_REQUEST(400)，实际 ${detail.contract_error_code}`];
    },
  },
  {
    id: 'D1-10',
    family: 'D1',
    title: '授权 epoch 撤回后的旧回调 ⇒ CALLBACK_EPOCH_REVOKED',
    expect: { code: 'CALLBACK_EPOCH_REVOKED' },
    async invoke() {
      const { h, task } = await queued();
      const env = envelopeForTask(task, { event_id: 'evt-d1-10', authorization_epoch: 2 });
      const outcome = await h.service.ingestCallback(signedCallback(env));
      return { code: outcome.accepted ? 'OK' : (outcome.reason_codes[0] ?? 'CALLBACK_NO_REASON_CODE'), detail: callbackView(outcome) };
    },
    check(detail) {
      return detail.contract_error_code === 'ACCOUNT_INACTIVE'
        ? []
        : [`epoch 已撤回应映射 ACCOUNT_INACTIVE(403)，实际 ${detail.contract_error_code}`];
    },
  },
  {
    id: 'D1-11',
    family: 'D1',
    title: '回调被接受 ⇒ 只落定筛查结论，**绝不**发布（权威侧可见性不变、读缓存不写）',
    expect: { code: 'OK' },
    async invoke() {
      const { h, task } = await queued();
      const outcome = await h.service.ingestCallback(signedCallback(envelopeForTask(task, { event_id: 'evt-d1-11' })));
      return {
        code: outcome.accepted ? 'OK' : (outcome.reason_codes[0] ?? 'CALLBACK_NO_REASON_CODE'),
        detail: {
          accepted: outcome.accepted,
          task_decision: outcome.task?.decision ?? null,
          authority_visibility: h.authority.get(task.target_ref) ?? null,
          cache_size: h.cache.size(),
        },
      };
    },
    check(detail) {
      const problems = [];
      if (detail.task_decision !== 'approved') problems.push(`前置：回调应落定 approved，实际 ${detail.task_decision}`);
      if (detail.authority_visibility !== null) {
        problems.push('回调**不得**发布：权威侧可见性本应为 null（未登记 = 未发布），实际 ' + JSON.stringify(detail.authority_visibility));
      }
      if (detail.cache_size !== 0) problems.push(`回调不得写读缓存，实际 cache_size=${detail.cache_size}`);
      return problems;
    },
  },

  // ---------------------------------------------------------------- D2 AI 失败
  {
    id: 'D2-01',
    family: 'D2',
    title: '模型端口抛错 ⇒ quarantined + PROVIDER_OUTCOME_UNKNOWN，发布被拒（INPUT_UNCERTAIN）',
    expect: { code: 'PROVIDER_OUTCOME_UNKNOWN' },
    async invoke() {
      const h = makeHarness({ ports: { tms: portThrowing(new Error('synthetic provider exploded')) } });
      const content = textContent();
      const res = await h.service.submitScreening({ actor: USER_A, content });
      const publishError = await captureError(() => h.service.publish({ actor: USER_A, content }));
      const view = screeningView(res);
      return {
        code: view.task_error_code ?? 'OK',
        detail: { ...view, publish_error_code: publishError?.code ?? null, publish_error_message: publishError?.message ?? null },
      };
    },
    check(detail) {
      const problems = [];
      if (detail.publishable !== false) problems.push('端口抛错时 overall.publishable 必须为 false');
      if (detail.task_reason_codes[0] !== 'MODEL_PORT_ERROR') {
        problems.push(`应登记原因码 MODEL_PORT_ERROR，实际 ${JSON.stringify(detail.task_reason_codes)}`);
      }
      if (detail.publish_error_code !== 'INPUT_UNCERTAIN') {
        problems.push(`发布必须被 INPUT_UNCERTAIN 拒绝，实际 ${detail.publish_error_code}`);
      }
      return problems;
    },
  },
  {
    id: 'D2-02',
    family: 'D2',
    title: '模型超时 ⇒ quarantined + PROVIDER_TIMEOUT（MODEL_TIMEOUT），不得发布',
    expect: { code: 'PROVIDER_TIMEOUT' },
    async invoke() {
      const timeoutError = Object.assign(new Error('synthetic timeout'), { name: 'TimeoutError' });
      const h = makeHarness({ ports: { tms: portThrowing(timeoutError) } });
      const res = await h.service.submitScreening({ actor: USER_A, content: textContent() });
      return { code: screeningView(res).task_error_code ?? 'OK', detail: screeningView(res) };
    },
    check(detail) {
      const problems = [];
      if (detail.publishable !== false) problems.push('超时不得 publishable=true');
      if (detail.task_reason_codes[0] !== 'MODEL_TIMEOUT') {
        problems.push(`应登记 MODEL_TIMEOUT，实际 ${JSON.stringify(detail.task_reason_codes)}`);
      }
      return problems;
    },
  },
  {
    id: 'D2-03',
    family: 'D2',
    title: '模型结论结构非法（label=maybe）⇒ quarantined + MODEL_RESPONSE_SHAPE_UNKNOWN',
    expect: { code: 'PROVIDER_OUTCOME_UNKNOWN' },
    async invoke() {
      const port = makePort({ kind: 'tms', evaluate: () => ({ label: 'maybe' }) });
      const h = makeHarness({ ports: { tms: port } });
      const res = await h.service.submitScreening({ actor: USER_A, content: textContent() });
      return { code: screeningView(res).task_error_code ?? 'OK', detail: screeningView(res) };
    },
    check(detail) {
      const problems = [];
      if (detail.publishable !== false) problems.push('结构错误不得 publishable=true');
      if (detail.task_reason_codes[0] !== 'MODEL_RESPONSE_SHAPE_UNKNOWN') {
        problems.push(`应登记 MODEL_RESPONSE_SHAPE_UNKNOWN，实际 ${JSON.stringify(detail.task_reason_codes)}`);
      }
      return problems;
    },
  },
  {
    id: 'D2-04',
    family: 'D2',
    title: '规则命中（PII）而模型说 pass ⇒ 仍 rejected，publishable=false（模型不得抬结论）',
    expect: { code: 'REJECTED_BY_RULES' },
    async invoke() {
      const h = makeHarness({ ports: { tms: makePort({ kind: 'tms', evaluate: () => passVerdict() }) } });
      const res = await h.service.submitScreening({ actor: USER_A, content: textContent({ text: PRIVACY_TEXT }) });
      const view = screeningView(res);
      return { code: view.task_decision === 'rejected' ? 'REJECTED_BY_RULES' : 'MODEL_OVERRULED_RULES', detail: { ...view, privacy_text: PRIVACY_TEXT } };
    },
    check(detail) {
      const problems = [];
      if (detail.publishable !== false) problems.push('规则命中不得 publishable=true');
      if (detail.hard_rule_passed !== false) problems.push(`hard_rule_passed 应为 false，实际 ${detail.hard_rule_passed}`);
      if (detail.task_reason_codes[0] !== 'PRIVACY_PII') {
        problems.push(`应登记 PRIVACY_PII，实际 ${JSON.stringify(detail.task_reason_codes)}`);
      }
      return problems;
    },
  },

  // ---------------------------------------------------------------- D3 下架缓存
  {
    id: 'D3-01',
    family: 'D3',
    title: '下架 ⇒ 读缓存键按 `type|id|revision` 失效，且读视图转 hidden',
    expect: { code: 'WITHDRAWN_CACHE_INVALIDATED' },
    async invoke() {
      const h = makeHarness({ ports: { tms: makePort({ kind: 'tms', evaluate: () => passVerdict() }) } });
      const content = textContent();
      seedAuthority(h.authority, content.target_ref, { owner_id: USER_A.userId });
      await h.service.submitScreening({ actor: USER_A, content });
      const published = await h.service.publish({ actor: USER_A, content });
      const before = await h.service.readView({ actor: USER_A, target_ref: content.target_ref });
      const withdrawn = await h.service.withdraw({ actor: ADMIN, target_ref: content.target_ref, reason_code: 'policy' });
      const after = await h.service.readView({ actor: USER_A, target_ref: content.target_ref });
      const expectedKey = `${content.target_ref.type}|${content.target_ref.id}|${content.target_ref.revision}`;
      const keys = [...withdrawn.invalidated_cache_keys];
      const ok = withdrawn.withdrawn === true && keys.includes(expectedKey) && after.visibility === 'hidden';
      return {
        code: ok ? 'WITHDRAWN_CACHE_INVALIDATED' : 'WITHDRAWN_CACHE_NOT_INVALIDATED',
        detail: {
          published: published.published,
          before_visibility: before.visibility ?? null,
          withdrawn: withdrawn.withdrawn,
          withdraw_visibility: withdrawn.visibility ?? null,
          invalidated_cache_keys: keys,
          expected_key: expectedKey,
          after_visibility: after.visibility ?? null,
          cache_size: h.cache.size(),
        },
      };
    },
    check(detail) {
      const problems = [];
      if (detail.published !== true) problems.push('前置：必须先真发布成功');
      if (detail.before_visibility !== 'published') problems.push(`前置：下架前读视图应为 published，实际 ${detail.before_visibility}`);
      if (detail.withdraw_visibility !== 'hidden') problems.push(`下架后应转 hidden，实际 ${detail.withdraw_visibility}`);
      return problems;
    },
  },
  {
    id: 'D3-02',
    family: 'D3',
    title: '下架是**幂等**的：第二次下架仍 withdrawn，且不得回退出缓存键',
    expect: { code: 'WITHDRAWN_IDEMPOTENT' },
    async invoke() {
      const h = makeHarness({ ports: { tms: makePort({ kind: 'tms', evaluate: () => passVerdict() }) } });
      const content = textContent();
      seedAuthority(h.authority, content.target_ref, { owner_id: USER_A.userId });
      await h.service.submitScreening({ actor: USER_A, content });
      await h.service.publish({ actor: USER_A, content });
      const first = await h.service.withdraw({ actor: ADMIN, target_ref: content.target_ref, reason_code: 'policy' });
      const second = await h.service.withdraw({ actor: ADMIN, target_ref: content.target_ref, reason_code: 'policy' });
      const view = await h.service.readView({ actor: USER_A, target_ref: content.target_ref });
      return {
        code: second.withdrawn === true && view.visibility === 'hidden' ? 'WITHDRAWN_IDEMPOTENT' : 'WITHDRAW_REGRESSED',
        detail: {
          first_keys: [...first.invalidated_cache_keys],
          second_keys: [...second.invalidated_cache_keys],
          second_visibility: second.visibility ?? null,
          view_visibility: view.visibility ?? null,
        },
      };
    },
    check(detail) {
      const problems = [];
      if (detail.second_visibility !== 'hidden') problems.push(`第二次下架后仍应 hidden，实际 ${detail.second_visibility}`);
      if (detail.second_keys.length !== 0) problems.push(`已失效过的键不应再回报，实际 ${JSON.stringify(detail.second_keys)}`);
      return problems;
    },
  },

  // ---------------------------------------------------------------- D4 版本回写（旧结论不得复用）
  {
    id: 'D4-01',
    family: 'D4',
    title: '内容推进到 rev2 后，rev1 的「已通过」结论**不得**复用：rev2 未筛查 ⇒ 发布被拒（NOT_SCREENED）',
    expect: { code: 'NOT_SCREENED_NEW_REVISION' },
    async invoke() {
      const h = makeHarness({ ports: { tms: makePort({ kind: 'tms', evaluate: () => passVerdict() }) } });
      const rev1 = textContent();
      const rev2 = textContent({ target_ref: { type: 'post', id: 'post-1001', revision: 2 } });
      seedAuthority(h.authority, rev1.target_ref, { owner_id: USER_A.userId });
      const screened1 = await h.service.submitScreening({ actor: USER_A, content: rev1 });
      const view1 = screeningView(screened1);
      // 内容改版：同一 target 的 current_revision 推进到 2（rev2 从未提交过筛查）。
      seedAuthority(h.authority, rev2.target_ref, { owner_id: USER_A.userId, current_revision: 2 });
      let code = 'PUBLISHED_WITHOUT_SCREENING';
      let detail = { rev1_overall: view1.overall_decision, rev1_publishable: view1.publishable, published: null, error_code: null, details: [] };
      try {
        const outcome = await h.service.publish({ actor: USER_A, content: rev2 });
        detail = { ...detail, published: outcome.published, published_revision: outcome.published_revision ?? null };
      } catch (error) {
        const details = error?.details ?? [];
        const serialized = JSON.stringify(details);
        detail = {
          ...detail,
          published: false,
          error_code: error?.code ?? null,
          details,
        };
        if (error?.code === 'INPUT_UNCERTAIN' && serialized.includes('NOT_SCREENED')) code = 'NOT_SCREENED_NEW_REVISION';
        else code = `UNEXPECTED_${error?.code ?? 'THROW'}`;
      }
      return { code, detail };
    },
    check(detail) {
      const problems = [];
      if (detail.rev1_overall !== 'approved') problems.push(`前置：rev1 必须先审成 approved，实际 ${detail.rev1_overall}`);
      if (detail.published !== false) problems.push('rev2 未筛查却发布成功（旧结论被复用）');
      return problems;
    },
  },
  {
    id: 'D4-02',
    family: 'D4',
    title: '正控制：rev2 自己审过（approved）后可以发布，且发布的就是 rev2（拒绝必须是「没审」，不是「一律不给发」）',
    expect: { code: 'REV2_PUBLISHED' },
    async invoke() {
      const h = makeHarness({ ports: { tms: makePort({ kind: 'tms', evaluate: () => passVerdict() }) } });
      const rev1 = textContent();
      const rev2 = textContent({ target_ref: { type: 'post', id: 'post-1001', revision: 2 } });
      seedAuthority(h.authority, rev1.target_ref, { owner_id: USER_A.userId });
      await h.service.submitScreening({ actor: USER_A, content: rev1 });
      seedAuthority(h.authority, rev2.target_ref, { owner_id: USER_A.userId, current_revision: 2 });
      const screened2 = await h.service.submitScreening({ actor: USER_A, content: rev2 });
      const view2 = screeningView(screened2);
      const outcome = await h.service.publish({ actor: USER_A, content: rev2 });
      const view = await h.service.readView({ actor: USER_A, target_ref: rev2.target_ref });
      return {
        code: outcome.published === true ? 'REV2_PUBLISHED' : 'REV2_BLOCKED',
        detail: {
          rev2_overall: view2.overall_decision,
          rev2_publishable: view2.publishable,
          published: outcome.published,
          published_revision: outcome.published_revision ?? null,
          view_visibility: view.visibility ?? null,
        },
      };
    },
    check(detail) {
      const problems = [];
      if (detail.rev2_overall !== 'approved') problems.push(`前置：rev2 应审成 approved，实际 ${detail.rev2_overall}`);
      if (detail.published_revision !== 2) problems.push(`发布的应是 rev2，实际 ${detail.published_revision}`);
      if (detail.view_visibility !== 'published') problems.push(`读视图应为 published，实际 ${detail.view_visibility}`);
      return problems;
    },
  },
  {
    id: 'D4-03',
    family: 'D4',
    title: '内容已推进到 rev2 时，rev1 的发布**必须**被挡回（REVISION_CONFLICT + REVISION_SUPERSEDED:2:1）',
    expect: { code: 'SUPERSEDED_REFUSED' },
    async invoke() {
      const h = makeHarness({ ports: { tms: makePort({ kind: 'tms', evaluate: () => passVerdict() }) } });
      const rev1 = textContent();
      seedAuthority(h.authority, rev1.target_ref, { owner_id: USER_A.userId });
      const screened1 = await h.service.submitScreening({ actor: USER_A, content: rev1 });
      const view1 = screeningView(screened1);
      // 编辑产生 rev2：权威行的 current_revision 变成 2，rev1 变成历史版本。
      seedAuthority(h.authority, rev1.target_ref, { owner_id: USER_A.userId, current_revision: 2 });
      let code = 'OLD_REVISION_PUBLISHED';
      let detail = { rev1_overall: view1.overall_decision, published: null, error_code: null, details: [] };
      try {
        const outcome = await h.service.publish({ actor: USER_A, content: rev1 });
        detail = { ...detail, published: outcome.published, published_revision: outcome.published_revision ?? null };
      } catch (error) {
        detail = { ...detail, published: false, error_code: error?.code ?? null, details: error?.details ?? [] };
        const serialized = JSON.stringify(detail.details);
        if (error?.code === 'REVISION_CONFLICT' && serialized.includes('REVISION_SUPERSEDED:2:1')) code = 'SUPERSEDED_REFUSED';
        else code = `UNEXPECTED_${error?.code ?? 'THROW'}`;
      }
      const view = await h.service.readView({ actor: USER_A, target_ref: rev1.target_ref });
      return { code, detail: { ...detail, view_visibility: view.visibility ?? null } };
    },
    check(detail) {
      const problems = [];
      if (detail.published !== false) problems.push('历史版本 rev1 竟然发布成功');
      if (detail.view_visibility === 'published') problems.push('rev1 仍被标成 published');
      return problems;
    },
  },
]);
