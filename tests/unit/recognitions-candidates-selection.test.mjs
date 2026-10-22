// GY-I09 第二片回归：候选至多 Top3 与不补造、六类失败/边界分支、用户选择独立记录、
// 选择后资料关联与 GY-I08 用量守卫、私有归属、real 未接提供者 fail-closed。
//
// 全部为**合成**身份 / 合成媒体引用 / 合成资料条目：不含真实个人媒体、真实凭据，
// 也不发起任何付费模型调用（`real` 分支一律断言 fail-closed，不回退替身）。
//
// 断言策略：先判 typeof 再判值；每条负例都**显式**断言状态与错误码，
// 不做「只要不抛错就算过」的写法，也不把「恰好没数据」当成「守卫生效」。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createSubstituteMediaPort } from '../../services/api/src/recognitions/media.ts';
import {
  branchOutcome,
  createBranchRecognitionProvider,
  createRealRecognitionProvider,
  createStubRecognitionProvider,
} from '../../services/api/src/recognitions/provider.ts';
import { createRecognitionService } from '../../services/api/src/recognitions/service.ts';
import { REASON_TIED_TOP_SCORE } from '../../services/api/src/recognitions/state.ts';
import {
  BRANCH_DESCRIPTORS,
  FAILURE_BRANCHES,
  RETRY_ACTIONS,
  branchCreatesJob,
  retrySemanticsFor,
} from '../../services/api/src/recognitions/branches.ts';
import {
  DOSE_PATH_BLOCK_CODE,
  LINKAGE_RULE_VERSION,
  LINKAGE_RULE_VERSION_REVIEWED_AGAINST,
  createReferenceLinkagePort,
  missingDoseConditions,
  requiresCompleteConditions,
  resolveSelectionLinkage,
} from '../../services/api/src/recognitions/linkage.ts';
import {
  MODEL_ATTRIBUTABLE_PROVENANCE,
  SELECTION_PROVENANCE,
  summarizeSelections,
} from '../../services/api/src/recognitions/selection.ts';
import { APPLICABILITY_RULE_VERSION, BLOCK_CODES } from '../../packages/reference/index.mjs';

const HMAC = 'synthetic-idempotency-hmac-key-0001';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const MEDIA_A = '33333333-3333-4333-8333-333333333333';
const KEY = (n) => `idem-${n}-0000000000`;

/** 脚本化提供者（合成）：按调用次序返回脚本项，可携带六类分支上报。 */
function scriptedProvider(script, overrides = {}) {
  const queue = [...script];
  const calls = [];
  return {
    executionMode: 'stub',
    modelVersion: 'stub-scripted-v1',
    available: true,
    unavailableReason: null,
    calls,
    async recognize(input) {
      calls.push(input);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return typeof next === 'function' ? next() : next;
    },
    ...overrides,
  };
}

function makeService({ provider, linkage, store } = {}) {
  const media = createSubstituteMediaPort();
  const service = createRecognitionService({
    store: store ?? createMemoryRecognitionStore(),
    provider: provider ?? createStubRecognitionProvider(),
    media,
    idempotencyHmacKey: HMAC,
    ...(linkage === undefined ? {} : { linkage }),
  });
  return { service, media };
}

/** 受理一个任务并等到终态，返回 Job 投影。 */
async function runJob(service, { userId = USER_A, mediaId = MEDIA_A, key = KEY('job') } = {}) {
  const created = await service.createRecognition({
    userId,
    body: { media_id: mediaId, media_revision: 1 },
    idempotencyKey: key,
  });
  await service.settle();
  return service.getJob({ userId, jobId: created.job.id });
}

/** 只读替身资料端口：给定条目集合，按品种恒定返回。 */
function fakePort(records, { kind = 'test_fake', note = '合成资料条目（测试替身）', throws } = {}) {
  return {
    kind,
    note,
    itemsForSpecies() {
      if (throws !== undefined) throw new Error(throws);
      return records;
    },
  };
}

const THREE_CANDIDATES = [
  { species_id: 'synthetic_weed_a', rank: 1, model_score: 0.81 },
  { species_id: 'synthetic_weed_b', rank: 2, model_score: 0.42 },
  { species_id: 'synthetic_weed_c', rank: 3, model_score: 0.17 },
];

/**
 * 经 GY-I08 判定**本可渲染**的合成资料条目（正控制）。
 *
 * 用于证明「经识别/选择路径取不到用量卡」是**路径的硬边界**，
 * 而不是「恰好这批资料没有用量」。字段逐项满足 labels.mjs `doseCardDescriptor` 的前置条件。
 */
function renderableRecord(overrides = {}) {
  const base = {
    record_id: 'rec-renderable-0001',
    registration_number: 'PD20210001',
    registered_name: '合成除草剂甲',
    dosage_form: '水分散粒剂',
    ingredients_text: '唑草酮 40%',
    use_scene: '水稻移栽田',
    growth_stage: '苗后',
    crop_ids: ['crop_rice'],
    region_codes: ['330100'],
    visibility: 'published',
    reference_state: 'available',
    simulated: false,
    source_version: 'sv-synthetic-1',
    source: {
      source_kind: 'database',
      evidence_kind: 'research',
      source_validity: 'valid',
      review_status: 'verified',
    },
    verification: {
      usable_as_dose: true,
      review_status: 'verified',
      restriction_status: 'unrestricted',
      dose: {
        number: '40',
        unit: '克/公顷',
        condition: '苗后茎叶喷雾',
        source_version: 'sv-synthetic-1',
        record_id: 'rec-renderable-0001',
        formulation: {
          registration_number: 'PD20210001',
          registered_name: '合成除草剂甲',
          dosage_form: '水分散粒剂',
          ingredients_text: '唑草酮 40%',
        },
        reference: '合成公告第 1 表',
      },
    },
    knowledge: { title: '合成除草剂甲 科普条目' },
  };
  return { ...base, ...overrides };
}

const COMPLETE_CONDITIONS = {
  crop_id: 'crop_rice',
  region_code: '330100',
  species_id: 'species_barnyardgrass',
  growth_stage: '苗后',
  planting_method: 'transplant',
  use_scene: '水稻移栽田',
};

// ---------------------------------------------------------------------------
// A. 候选至多 Top3、不补造、无分数不伪造
// ---------------------------------------------------------------------------

test('GY-I09 候选：至多 Top3、少于 3 不补造、无分数不伪造高置信', async (t) => {
  await t.test('3 条有分数候选 → succeeded，candidates 恰好 3 条且 rank 1..3', async () => {
    const { service } = makeService({ provider: scriptedProvider([{ kind: 'completed', candidates: THREE_CANDIDATES }]) });
    const job = await runJob(service);
    assert.equal(job.state, 'succeeded', JSON.stringify(job));
    assert.equal(job.error_code, null);
    assert.equal(job.result.value.candidates.length, 3);
    assert.deepEqual(job.result.value.candidates.map((c) => c.rank), [1, 2, 3]);
    assert.deepEqual(job.result.value.uncertainty_reasons, []);
    assert.equal(job.result.value.model_version, 'stub-scripted-v1');
  });

  await t.test('[不补造] 2 条有分数候选 → succeeded，candidates 恰好 2 条（不得凑第 3 条）', async () => {
    const { service } = makeService({
      provider: scriptedProvider([{ kind: 'completed', candidates: THREE_CANDIDATES.slice(0, 2) }]),
    });
    const job = await runJob(service);
    assert.equal(job.state, 'succeeded', JSON.stringify(job));
    assert.equal(job.result.value.candidates.length, 2, '候选少于 3 条不得补造');
    assert.deepEqual(job.result.value.candidates.map((c) => c.species_id), ['synthetic_weed_a', 'synthetic_weed_b']);
  });

  await t.test('0 条候选 → uncertain（绝不落 succeeded），且有如实原因', async () => {
    const { service } = makeService({ provider: scriptedProvider([{ kind: 'completed', candidates: [] }]) });
    const job = await runJob(service);
    assert.equal(job.state, 'uncertain', JSON.stringify(job));
    assert.equal(job.result.value.candidates.length, 0);
    assert.ok(job.result.value.uncertainty_reasons.length >= 1, '无候选必须给出原因');
  });

  await t.test('[反例] 4 条候选 → failed PROVIDER_OUTCOME_UNKNOWN（不截断成 3 条）', async () => {
    const four = [...THREE_CANDIDATES, { species_id: 'synthetic_weed_d', rank: 4, model_score: 0.05 }];
    const { service } = makeService({ provider: scriptedProvider([{ kind: 'completed', candidates: four }]) });
    const job = await runJob(service);
    assert.equal(job.state, 'failed', JSON.stringify(job));
    assert.equal(job.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
    assert.equal(job.result, null, '协议违规不得留下识别记录');
  });

  await t.test('[无分数不伪造] model_score=null → uncertain，且响应中没有任何分数被补写', async () => {
    const { service } = makeService({
      provider: scriptedProvider([
        {
          kind: 'completed',
          candidates: [
            { species_id: 'synthetic_weed_a', rank: 1, model_score: null },
            { species_id: 'synthetic_weed_b', rank: 2, model_score: null },
          ],
        },
      ]),
    });
    const job = await runJob(service);
    assert.equal(job.state, 'uncertain', JSON.stringify(job));
    for (const candidate of job.result.value.candidates) {
      assert.equal(candidate.model_score, null, '没有分数时不得写入任何分数');
      assert.equal(typeof candidate.model_score === 'number', false, '不得以 0 或任何数字代填');
    }
    assert.ok(job.result.value.uncertainty_reasons.length >= 1);
  });

  await t.test('[无分数不伪造] Top1 分数低于可信门槛 → uncertain，不得包装成高置信成功', async () => {
    const { service } = makeService({
      provider: scriptedProvider([
        {
          kind: 'completed',
          candidates: [
            { species_id: 'synthetic_weed_a', rank: 1, model_score: 0.4 },
            { species_id: 'synthetic_weed_b', rank: 2, model_score: 0.2 },
          ],
        },
      ]),
    });
    const job = await runJob(service);
    assert.equal(job.state, 'uncertain', JSON.stringify(job));
    assert.notEqual(job.state, 'succeeded', '低分不得被写成成功');
    assert.ok(job.result.value.uncertainty_reasons.length >= 1);
  });

  await t.test('[同分并列] Top1 与 Top2 分数相同 → uncertain，不得拿 rank 顺序假装确定', async () => {
    // 边界：两条候选分数完全相同（不是缺分数、也不低于门槛）。
    // 此时「谁是最可能的」不可区分：既不能任选 rank 1 当结果，也不能合并两条。
    const tied = [
      { species_id: 'synthetic_weed_a', rank: 1, model_score: 0.66 },
      { species_id: 'synthetic_weed_b', rank: 2, model_score: 0.66 },
      { species_id: 'synthetic_weed_c', rank: 3, model_score: 0.17 },
    ];
    const { service } = makeService({ provider: scriptedProvider([{ kind: 'completed', candidates: tied }]) });
    const job = await runJob(service);
    assert.equal(job.state, 'uncertain', JSON.stringify(job));
    assert.notEqual(job.state, 'succeeded', '同分并列不得被写成成功');
    assert.deepEqual([...job.result.value.uncertainty_reasons], [REASON_TIED_TOP_SCORE], '必须如实给出同分原因');
    // 分数/候选原样保留：不补造区分依据、不去重、不改 rank。
    assert.deepEqual(
      job.result.value.candidates.map((c) => [c.species_id, c.rank, c.model_score]),
      [['synthetic_weed_a', 1, 0.66], ['synthetic_weed_b', 2, 0.66], ['synthetic_weed_c', 3, 0.17]],
    );
    assert.equal(job.result.value.selected_species_id, null, '同分并列不得自动选定某个品种');
  });

  await t.test('[同分不算并列] Top1 与 Top2 分数不同时仍按唯一 Top1 判 succeeded', async () => {
    // 正控制：证明上面的规则没有把正常执行路径也判成 uncertain。
    const { service } = makeService({ provider: scriptedProvider([{ kind: 'completed', candidates: THREE_CANDIDATES }]) });
    const job = await runJob(service);
    assert.equal(job.state, 'succeeded', JSON.stringify(job));
    assert.deepEqual([...job.result.value.uncertainty_reasons], []);
  });
});

// ---------------------------------------------------------------------------
// B. 六类失败/边界分支
// ---------------------------------------------------------------------------

test('GY-I09 六类失败/边界分支：闭集、契约内落点与可重试语义', async (t) => {
  await t.test('分支闭集恰为 6 类，且逐类有契约内落点与唯一重试动作', () => {
    assert.equal(FAILURE_BRANCHES.length, 6, '六类分支闭集');
    assert.deepEqual(
      [...FAILURE_BRANCHES],
      ['uncertain', 'out_of_coverage_or_low_quality', 'permission_denied', 'no_result', 'timeout', 'reshoot_required'],
    );
    for (const branch of FAILURE_BRANCHES) {
      const descriptor = BRANCH_DESCRIPTORS[branch];
      assert.equal(descriptor.branch, branch);
      const retry = retrySemanticsFor(branch);
      assert.equal(typeof retry.retryable, 'boolean', `${branch} 必须给出可重试语义`);
      if (retry.retryable) {
        assert.ok(RETRY_ACTIONS.includes(retry.retryAction), `${branch} 的重试动作必须属于闭集`);
      } else {
        assert.equal(retry.retryAction, null);
      }
    }
    // 权限拒绝是**受理前**拦截：不得凭空造出一个任务。
    assert.equal(branchCreatesJob('permission_denied'), false);
    assert.equal(BRANCH_DESCRIPTORS.permission_denied.jobState, null);
    assert.equal(BRANCH_DESCRIPTORS.permission_denied.errorCode, 'CONSENT_REQUIRED');
    // 其余五类都必须落在契约既有 JobState 上（不得新增状态）。
    for (const branch of FAILURE_BRANCHES.filter((b) => b !== 'permission_denied')) {
      assert.ok(['uncertain', 'timed_out'].includes(BRANCH_DESCRIPTORS[branch].jobState), `${branch} 的落点必须合法`);
    }
  });

  await t.test('① 不确定：uncertain + 原因，且不得 succeeded', async () => {
    const { service } = makeService({ provider: createBranchRecognitionProvider({ branch: 'uncertain' }) });
    const job = await runJob(service);
    assert.equal(job.state, 'uncertain', JSON.stringify(job));
    assert.equal(job.error_code, null);
    assert.equal(branchCreatesJob('uncertain'), true);
    assert.equal(retrySemanticsFor('uncertain').retryAction, 'new_task');
  });

  await t.test('② 覆盖外/低质量：uncertain + 如实原因；即便同时返回高分候选也不得算成功（关键负例）', async () => {
    // 负例核心：提供者一边说「覆盖外」，一边给出 Top1=0.95 的高分候选 ——
    // 需求第 6 节的 outOfCoverageHighConfidenceRate 口径要求它**绝不能**成为可信成功。
    const { service } = makeService({
      provider: scriptedProvider([
        {
          kind: 'completed',
          candidates: [{ species_id: 'synthetic_weed_a', rank: 1, model_score: 0.95 }],
          uncertainty_reasons: [],
          branch: 'out_of_coverage_or_low_quality',
        },
      ]),
    });
    const job = await runJob(service);
    assert.equal(job.state, 'uncertain', '覆盖外不得落 succeeded：' + JSON.stringify(job));
    assert.notEqual(job.state, 'succeeded');
    assert.ok(
      job.result.value.uncertainty_reasons.includes(BRANCH_DESCRIPTORS.out_of_coverage_or_low_quality.reason),
      JSON.stringify(job.result.value.uncertainty_reasons),
    );
    assert.equal(retrySemanticsFor('out_of_coverage_or_low_quality').retryAction, 'reshoot');
  });

  await t.test('③ 无结果：uncertain + 「未返回任何候选」原因', async () => {
    const { service } = makeService({ provider: createBranchRecognitionProvider({ branch: 'no_result' }) });
    const job = await runJob(service);
    assert.equal(job.state, 'uncertain', JSON.stringify(job));
    assert.equal(job.result.value.candidates.length, 0);
    assert.ok(job.result.value.uncertainty_reasons.length >= 1);
    assert.equal(retrySemanticsFor('no_result').retryAction, 'reshoot');
  });

  await t.test('④ 超时：timed_out + PROVIDER_TIMEOUT（迟到结果不复活）', async () => {
    const { service } = makeService({ provider: createBranchRecognitionProvider({ branch: 'timeout' }) });
    const job = await runJob(service);
    assert.equal(job.state, 'timed_out', JSON.stringify(job));
    assert.equal(job.error_code, 'PROVIDER_TIMEOUT');
    assert.equal(job.result, null, '超时不得留下识别记录');
    assert.equal(retrySemanticsFor('timeout').retryAction, 'new_task');
  });

  await t.test('⑤ 重拍：uncertain + 重拍原因，重试动作恒为 reshoot', async () => {
    const { service } = makeService({ provider: createBranchRecognitionProvider({ branch: 'reshoot_required' }) });
    const job = await runJob(service);
    assert.equal(job.state, 'uncertain', JSON.stringify(job));
    assert.ok(
      job.result.value.uncertainty_reasons.includes(BRANCH_DESCRIPTORS.reshoot_required.reason),
      JSON.stringify(job.result.value.uncertainty_reasons),
    );
    const retry = retrySemanticsFor('reshoot_required');
    assert.equal(retry.retryable, true);
    assert.equal(retry.retryAction, 'reshoot');
  });

  await t.test('⑥ 权限拒绝：受理前 403 CONSENT_REQUIRED，不创建任务、不产生识别记录', async () => {
    // 提供者侧永远不得把「权限拒绝」当一次已执行结果：必须表达为 failed。
    assert.deepEqual(await branchOutcome('permission_denied'), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
    assert.deepEqual(await branchOutcome('timeout'), { kind: 'failed', code: 'PROVIDER_TIMEOUT' });
    // 契约内落点断言（HTTP 层接线回归见 tests/unit/privacy-consent-wiring.test.mjs）。
    assert.equal(BRANCH_DESCRIPTORS.permission_denied.jobState, null);
    assert.equal(BRANCH_DESCRIPTORS.permission_denied.errorCode, 'CONSENT_REQUIRED');
    assert.equal(retrySemanticsFor('permission_denied').retryAction, 'grant_consent');
    // R31-S-retryable：本轮**保留** `retryable`（页面靠它渲染「去授权」入口，见 miniprogram
    // `pages/identify/identify.wxml`），但把「必须先由人补授权」显式建模成独立字段，
    // ⛔ 任何自动重试调度都不得据 `retryable:true` 触发（授权不经人工介入永远不会变好）。
    assert.equal(
      retrySemanticsFor('permission_denied').retryable,
      true,
      '恢复入口仍需保留（否则页面失去「去授权」按钮）',
    );
    assert.equal(
      retrySemanticsFor('permission_denied').requiresHumanAction,
      true,
      '授权类分支必须先由人介入，自动重试不可能成功',
    );
    for (const branch of FAILURE_BRANCHES) {
      if (branch === 'permission_denied') continue;
      assert.equal(
        retrySemanticsFor(branch).requiresHumanAction,
        false,
        `${branch} 的恢复入口不依赖人工前置动作，不得被误标`,
      );
    }
  });

  await t.test('[反例] 上报非闭集分支 → failed PROVIDER_OUTCOME_UNKNOWN（不静默忽略）', async () => {
    const { service } = makeService({
      provider: scriptedProvider([
        { kind: 'completed', candidates: THREE_CANDIDATES, uncertainty_reasons: [], branch: 'not_a_real_branch' },
      ]),
    });
    const job = await runJob(service);
    assert.equal(job.state, 'failed', JSON.stringify(job));
    assert.equal(job.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
    assert.equal(job.result, null);
  });

  await t.test('分支指引经服务导出：逐类字段与闭集一致（跨端锚点）', () => {
    const { service } = makeService({});
    const guide = service.branchGuide();
    assert.equal(guide.length, 6);
    assert.deepEqual(guide.map((entry) => entry.branch), [...FAILURE_BRANCHES]);
    for (const entry of guide) {
      assert.equal(entry.job_state, BRANCH_DESCRIPTORS[entry.branch].jobState);
      assert.equal(entry.error_code, BRANCH_DESCRIPTORS[entry.branch].errorCode);
      assert.equal(
        entry.requires_human_action,
        retrySemanticsFor(entry.branch).requiresHumanAction,
        '人工介入轴必须与 branches.ts 同源投影',
      );
      assert.equal(entry.creates_job, branchCreatesJob(entry.branch));
    }
  });
});

// ---------------------------------------------------------------------------
// C. 用户选择独立记录
// ---------------------------------------------------------------------------

test('GY-I09 用户选择独立记录：与候选分离、append-only、不计模型成绩、归属私有', async (t) => {
  const provider = scriptedProvider([{ kind: 'completed', candidates: THREE_CANDIDATES }]);
  await t.test('选择只写 selected_species_id；候选/分数/模型版本逐字不变；选择独立成行', async () => {
    const { service } = makeService({ provider });
    const job = await runJob(service, { key: KEY('sel-create') });
    const recordId = job.target_ref.id;
    const before = await service.getRecognition({ userId: USER_A, recognitionId: recordId });
    const selected = await service.selectSpecies({
      userId: USER_A,
      recognitionId: recordId,
      body: { selected_species_id: 'synthetic_weed_b' },
      ifMatch: `"${before.revision}"`,
      idempotencyKey: KEY('sel-1'),
    });
    assert.equal(selected.selected_species_id, 'synthetic_weed_b');
    // 模型原始候选逐字不变。
    assert.deepEqual(selected.candidates, before.candidates);
    assert.equal(selected.model_version, before.model_version);
    assert.deepEqual(selected.candidates.map((c) => c.model_score), [0.81, 0.42, 0.17]);

    const { items, summary } = await service.listSelections({ userId: USER_A, recognitionId: recordId });
    assert.equal(items.length, 1, '人工选择必须独立成行');
    const row = items[0];
    assert.notEqual(row.id, recordId, '选择记录有独立的 id');
    assert.equal(row.recognitionId, recordId);
    assert.equal(row.speciesId, 'synthetic_weed_b');
    assert.equal(row.provenance, 'human');
    assert.equal(row.ownerUserId, USER_A);
    assert.equal(typeof row.decidedAt, 'object');
    // 选择行**不含**任何模型候选分数。
    assert.equal('candidates' in row, false, '选择行不得混入模型候选');
    assert.equal(JSON.stringify(row).includes('model_score'), false, '选择行不得含任何 model_score');
    assert.equal(summary.total, 1);
    assert.equal(summary.by_provenance.human, 1);
  });

  await t.test('改选 append-only：追加第二行，第一条历史仍在（不覆盖）', async () => {
    const { service } = makeService({ provider });
    const job = await runJob(service, { key: KEY('sel2-create') });
    const recordId = job.target_ref.id;
    const first = await service.selectSpecies({
      userId: USER_A, recognitionId: recordId, body: { selected_species_id: 'synthetic_weed_a' },
      ifMatch: '"1"', idempotencyKey: KEY('sel2-a'),
    });
    const second = await service.selectSpecies({
      userId: USER_A, recognitionId: recordId, body: { selected_species_id: 'synthetic_weed_c' },
      ifMatch: `"${first.revision}"`, idempotencyKey: KEY('sel2-b'),
    });
    assert.equal(second.selected_species_id, 'synthetic_weed_c');
    const { items } = await service.listSelections({ userId: USER_A, recognitionId: recordId });
    assert.equal(items.length, 2, '改选只追加、不覆盖');
    assert.deepEqual(items.map((item) => item.speciesId), ['synthetic_weed_a', 'synthetic_weed_c']);
  });

  await t.test('幂等：同键同体重放不追加第二行，且回放同一识别状态', async () => {
    const { service } = makeService({ provider });
    const job = await runJob(service, { key: KEY('sel3-create') });
    const recordId = job.target_ref.id;
    const args = {
      userId: USER_A, recognitionId: recordId, body: { selected_species_id: 'synthetic_weed_a' },
      ifMatch: '"1"', idempotencyKey: KEY('sel3-same'),
    };
    const one = await service.selectSpecies(args);
    const two = await service.selectSpecies(args);
    assert.deepEqual(two, one, '原样重放必须回放同一结果');
    const { items } = await service.listSelections({ userId: USER_A, recognitionId: recordId });
    assert.equal(items.length, 1, '幂等重放不得追加第二条选择记录');
  });

  await t.test('[不得计模型成绩] 来源闭集与模型成绩无交集：model_attributable 恒为 0', () => {
    assert.deepEqual([...SELECTION_PROVENANCE], ['human', 'manual_override', 'preset_demo']);
    assert.deepEqual([...MODEL_ATTRIBUTABLE_PROVENANCE], [], '没有任何用户选择来源可计入模型成绩');
    const rows = SELECTION_PROVENANCE.map((provenance, index) => ({
      id: `r-${index}`, revision: 1, recognitionId: 'x', ownerUserId: USER_A, speciesId: 's',
      provenance, decidedAt: new Date(1000 * (index + 1)), linkage: null,
    }));
    const summary = summarizeSelections(rows);
    assert.equal(summary.total, 3);
    assert.equal(summary.model_attributable, 0, '手改/预设一律不得计入模型成绩');
    assert.equal(summary.by_provenance.human, 1);
    assert.equal(summary.by_provenance.manual_override, 1);
    assert.equal(summary.by_provenance.preset_demo, 1);
  });

  await t.test('[私有归属] 他人读不到选择记录；越权与不存在同形 NOT_FOUND', async () => {
    const { service } = makeService({ provider });
    const job = await runJob(service, { userId: USER_A, key: KEY('own-create') });
    const recordId = job.target_ref.id;
    await service.selectSpecies({
      userId: USER_A, recognitionId: recordId, body: { selected_species_id: 'synthetic_weed_a' },
      ifMatch: '"1"', idempotencyKey: KEY('own-sel'),
    });
    await assert.rejects(
      () => service.listSelections({ userId: USER_B, recognitionId: recordId }),
      (error) => error.code === 'NOT_FOUND',
      'B 用户读 A 的选择记录必须 NOT_FOUND',
    );
    // store 层同样按归属过滤（不是只靠上层再筛一遍）。
    const store = createMemoryRecognitionStore();
    const direct = await store.listSelections(recordId, USER_B);
    assert.deepEqual(direct, [], 'store 层按归属过滤，他人拿不到任何行');
  });
});

// ---------------------------------------------------------------------------
// D. 选择后资料关联与 GY-I08 用量守卫
// ---------------------------------------------------------------------------

test('GY-I09 选择后资料关联：只取有效/可访问/非模拟，条件不全阻断，用量恒被 GY-I08 守卫阻断', async (t) => {
  const eligible = renderableRecord();
  const expired = renderableRecord({ record_id: 'rec-expired', registration_number: 'PD20210002', source: { ...renderableRecord().source, source_validity: 'expired' } });
  const hidden = renderableRecord({ record_id: 'rec-hidden', registration_number: 'PD20210003', visibility: 'hidden' });
  const simulated = renderableRecord({
    record_id: 'rec-sim', registration_number: 'SIM-0001', simulated: true,
    source: { ...renderableRecord().source, source_kind: 'simulation' },
  });

  await t.test('只取有效/可访问/非模拟：失效/下架/模拟一律排除且**带原因**', () => {
    const linkage = resolveSelectionLinkage({
      speciesId: 'species_barnyardgrass',
      conditions: COMPLETE_CONDITIONS,
      records: [eligible, expired, hidden, simulated],
    });
    assert.equal(linkage.items.length, 1, JSON.stringify(linkage.items));
    assert.equal(linkage.items[0].record_id, 'rec-renderable-0001');
    assert.equal(linkage.items[0].source_kind, 'database');
    assert.equal(linkage.reference_state, 'available');
    assert.equal(linkage.excluded.length, 3, JSON.stringify(linkage.excluded));
    for (const row of linkage.excluded) {
      assert.equal(typeof row.reason, 'string');
      assert.ok(row.reason.length > 0, '排除必须带如实原因');
    }
    const excludedIds = linkage.excluded.map((row) => row.record_id).sort();
    assert.deepEqual(excludedIds, ['rec-expired', 'rec-hidden', 'rec-sim']);
    assert.ok(linkage.excluded.some((row) => row.record_id === 'rec-sim' && row.reason.includes('模拟')));
  });

  await t.test('[条件不全阻断] 条件不完整 → 422 CONDITIONS_INCOMPLETE，且逐项列出缺项', () => {
    assert.equal(LINKAGE_RULE_VERSION, APPLICABILITY_RULE_VERSION);
    assert.deepEqual(missingDoseConditions(COMPLETE_CONDITIONS), []);
    const incomplete = { crop_id: 'crop_rice', region_code: '330100' };
    const missing = missingDoseConditions(incomplete);
    assert.ok(missing.includes('species_id') && missing.includes('growth_stage') && missing.includes('planting_method') && missing.includes('use_scene'));
    assert.throws(
      () => requiresCompleteConditions(incomplete),
      (error) => error.code === 'CONDITIONS_INCOMPLETE' && error.status === 422,
      '条件不全必须被阻断为 422 CONDITIONS_INCOMPLETE',
    );
    // 形状不符的地区码同样算缺项（不静默接受）。
    assert.ok(missingDoseConditions({ ...COMPLETE_CONDITIONS, region_code: '9911' }).includes('region_code'));
    const linkage = resolveSelectionLinkage({ speciesId: 'species_barnyardgrass', conditions: incomplete, records: [eligible] });
    assert.equal(linkage.conditions_complete, false);
    assert.ok(linkage.blocked_codes.includes(BLOCK_CODES.MISSING_CONDITION), JSON.stringify(linkage.blocked_codes));
  });

  await t.test('[关键负例·不得绕过 #8] 条件完整且资料经 GY-I08 判定本可渲染 → 经识别/选择路径仍**取不到用量卡**', () => {
    // 正控制：该条目在 GY-I08 本身口径下是可渲染的（否则「阻断」就没有证明力）。
    const linkage = resolveSelectionLinkage({
      speciesId: 'species_barnyardgrass',
      conditions: COMPLETE_CONDITIONS,
      records: [eligible],
    });
    assert.equal(linkage.conditions_complete, true, '本次条件必须完整，才能证明是路径在阻断');
    assert.equal(linkage.dose.conditionally_renderable_count, 1, '正控制：该条目本身经 GY-I08 判定可渲染');
    // 负例：识别/选择路径**恒不产出用量**。
    assert.equal(linkage.dose.renderable, false, '识别路径不得产出用量');
    assert.equal(linkage.dose.card, null, '识别路径不得带出任何剂量载荷');
    assert.equal(linkage.dose.block_code, BLOCK_CODES.NO_DOSE_SOURCE);
    assert.equal(linkage.dose.blocked_by_path, 'recognition_selection');
    // 条目级判定是**真**（正控制：GY-I08 自己认为这张卡可以渲染），
    // 因此条目级没有阻断类别；阻断来自**路径**（下一条断言）。
    assert.equal(linkage.dose.per_item[0].renderable, true, '条目级判定为真（正控制）');
    assert.equal(linkage.dose.per_item[0].block_code, null, '条目级无阻断（正控制）');
    assert.equal(linkage.dose.per_item[0].rule_version, APPLICABILITY_RULE_VERSION, '条目级判定与 GY-I08 同版本');
    // 路径级：识别/选择这条路径**恒**阻断（不是"条目不合格"）。
    assert.equal(linkage.dose.block_code, DOSE_PATH_BLOCK_CODE);
    assert.equal(DOSE_PATH_BLOCK_CODE, BLOCK_CODES.NO_DOSE_SOURCE);
    assert.ok(linkage.blocked_codes.includes(BLOCK_CODES.NO_DOSE_SOURCE));
    assert.equal(LINKAGE_RULE_VERSION, 'gy-i08/1.2.0');
    assert.equal(LINKAGE_RULE_VERSION_REVIEWED_AGAINST, 'gy-i08/1.2.0');
  });

  await t.test('经**服务**选择后仍取不到用量：选择记录里的 linkage dose 恒不可渲染', async () => {
    const { service } = makeService({
      provider: scriptedProvider([{ kind: 'completed', candidates: THREE_CANDIDATES }]),
      linkage: fakePort([eligible]),
    });
    const job = await runJob(service, { key: KEY('dose-create') });
    const recordId = job.target_ref.id;
    await service.selectSpecies({
      userId: USER_A, recognitionId: recordId, body: { selected_species_id: 'synthetic_weed_a' },
      ifMatch: '"1"', idempotencyKey: KEY('dose-sel'),
    });
    const { items } = await service.listSelections({ userId: USER_A, recognitionId: recordId });
    const linkage = items[0].linkage;
    assert.equal(linkage.items.length, 1);
    assert.equal(linkage.dose.renderable, false);
    assert.equal(linkage.dose.card, null);
    assert.equal(linkage.dose.block_code, BLOCK_CODES.NO_DOSE_SOURCE);
    assert.equal(linkage.rule_version, APPLICABILITY_RULE_VERSION, '与 GY-I08 同规则版本');
  });

  await t.test('关联未取得：选择**仍成功**，但记录如实标 unavailable + 原因（不用空资料冒充"查过但没有"）', async () => {
    const { service } = makeService({
      provider: scriptedProvider([{ kind: 'completed', candidates: THREE_CANDIDATES }]),
      linkage: fakePort([], { throws: '合成资料装载失败' }),
    });
    const job = await runJob(service, { key: KEY('fail-create') });
    const recordId = job.target_ref.id;
    const selected = await service.selectSpecies({
      userId: USER_A, recognitionId: recordId, body: { selected_species_id: 'synthetic_weed_a' },
      ifMatch: '"1"', idempotencyKey: KEY('fail-sel'),
    });
    assert.equal(selected.selected_species_id, 'synthetic_weed_a', '关联失败不得使选择失败');
    const { items } = await service.listSelections({ userId: USER_A, recognitionId: recordId });
    assert.equal(items[0].linkage.reference_state, 'unavailable');
    assert.ok(items[0].linkage.note.includes('关联未取得'), items[0].linkage.note);
    assert.equal(items[0].linkage.dose.renderable, false, '关联未取得时同样不得产出用量');
  });

  await t.test('真实域库端口（已合入资料）：命中真实条目，且恒无用量（未采集用量列）', () => {
    const port = createReferenceLinkagePort();
    const records = port.itemsForSpecies('species_barnyardgrass');
    assert.ok(records.length >= 1, '稗草应命中真实公告附表记录');
    const linkage = resolveSelectionLinkage({
      speciesId: 'species_barnyardgrass', conditions: COMPLETE_CONDITIONS, records,
    });
    assert.equal(linkage.reference_state, 'available');
    assert.ok(linkage.items.length >= 1);
    assert.equal(linkage.dose.renderable, false);
    assert.equal(linkage.dose.conditionally_renderable_count, 0, '真实资料未采集用量 → 恒不可渲染');
    assert.equal(linkage.dose.card, null);
    // 未采集禁限用 → fail-closed 阻断（不得当作"可安全使用"），并如实给出原因。
    const item = linkage.items[0];
    assert.equal(item.applicable, false, '未采集禁限用不得判为适用');
    assert.ok(item.blocked_codes.includes('banned_restricted'), JSON.stringify(item.blocked_codes));
    assert.ok(
      item.reasons.some((reason) => reason.includes('未采集禁限用')),
      JSON.stringify(item.reasons),
    );
    // 未命中的品种如实返回空（不伪造资料）。
    assert.deepEqual(createReferenceLinkagePort().itemsForSpecies('species_not_in_catalog'), []);
  });
});

// ---------------------------------------------------------------------------
// E. real 未接真实提供者 fail-closed + stub 对照
// ---------------------------------------------------------------------------

test('GY-I09 real 未接真实提供者 fail-closed（契约内 503 / failed），stub 对照正常', async (t) => {
  const base = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });

  await t.test('real + 无凭据 ⇒ POST 503 PROVIDER_UNAVAILABLE（受理前，无成功封套）', async () => {
    const authStore = createMemoryAuthStore();
    const app = buildApp({
      config: { ...base, executionMode: 'real' },
      store: authStore,
      recognitionProvider: createRealRecognitionProvider({ endpoint: null, apiKey: null }),
      recognitionMedia: createSubstituteMediaPort(),
    });
    t.after(() => app.close());
    const token = 'synthetic-real-token-0001';
    const user = await authStore.createUser('synthetic-subject-real-0001');
    await authStore.createSession({
      userId: user.id, tokenHashHex: hashToken(token), authEpoch: user.authEpoch,
      expiresAt: new Date(Date.now() + 3600 * 1000), audience: 'user',
    });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/recognitions',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': KEY('real-none') },
      payload: { media_id: MEDIA_A, media_revision: 1 },
    });
    assert.equal(r.statusCode, 503, r.body);
    const body = r.json();
    assert.equal(body.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(
      body.error.retryable,
      false,
      '能力未接线（受理前 fail-closed）⇒ retryable 必须为 false：同一请求重试不会成功，需运维改配置',
    );
    assert.equal(body.data, undefined, '不得以内存/替身返回成功封套');
    // 不得回退替身：没有任何 Job/候选/模型版本字段。
    assert.equal(body.error.details.length, 0);
  });

  await t.test('real + 凭据齐备但无已审适配器 ⇒ 任务 failed PROVIDER_UNAVAILABLE（不回退替身）', async () => {
    const authStore = createMemoryAuthStore();
    const app = buildApp({
      config: { ...base, executionMode: 'real' },
      store: authStore,
      recognitionProvider: createRealRecognitionProvider({ endpoint: 'https://vendor.invalid/v1', apiKey: 'synthetic-key-0123456789' }),
      recognitionMedia: createSubstituteMediaPort(),
    });
    t.after(() => app.close());
    const token = 'synthetic-real-token-0002';
    const user = await authStore.createUser('synthetic-subject-real-0002');
    await authStore.createSession({
      userId: user.id, tokenHashHex: hashToken(token), authEpoch: user.authEpoch,
      expiresAt: new Date(Date.now() + 3600 * 1000), audience: 'user',
    });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/recognitions',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': KEY('real-creds') },
      payload: { media_id: MEDIA_A, media_revision: 1 },
    });
    assert.equal(r.statusCode, 202, r.body);
    const created = r.json();
    assert.equal(created.meta.execution_mode, 'real');
    assert.equal(created.data.result, null);
    // 等待终态
    let job = null;
    const deadline = Date.now() + 3000;
    for (;;) {
      const got = await app.inject({
        method: 'GET', url: `/api/v1/jobs/${created.data.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(got.statusCode, 200, got.body);
      job = got.json().data;
      if (['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'].includes(job.state)) break;
      if (Date.now() > deadline) throw new Error('等待终态超时');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(job.state, 'failed', JSON.stringify(job));
    assert.equal(job.error_code, 'PROVIDER_UNAVAILABLE');
    assert.equal(job.result, null, 'real 无已审适配器不得产出任何识别结果');
  });

  await t.test('[stub 对照] 同一路径在 stub 下正常产出（证明上面的 fail-closed 来自 real 未接线）', async () => {
    const { service } = makeService({ provider: createStubRecognitionProvider() });
    const job = await runJob(service, { mediaId: MEDIA_A, key: KEY('stub-ctrl') });
    assert.ok(['succeeded', 'uncertain'].includes(job.state), JSON.stringify(job));
    assert.notEqual(job.state, 'failed');
    assert.ok(job.result !== null, 'stub 对照必须真的产出结果');
    assert.equal(job.result.value.model_version, 'stub-v1');
    assert.equal(service.describe().executionMode, 'stub');
    assert.equal(service.describe().selectionModelAttributable, false);
    assert.equal(service.describe().storePersistent, false);
  });
});
