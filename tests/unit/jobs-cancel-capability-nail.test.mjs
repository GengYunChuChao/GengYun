/**
 * W29 · 六源取消能力钉子（`POST /jobs/{id}/cancel` 的能力矩阵 + 装配点注释真话）。
 *
 * 为什么有这片：`services/api/src/app.ts:2540-2541` 曾把 OCR 作业源的注释写成
 * 「`cancel` **不提供** ⇒ 503」，并把注册表那条 503 分支的 `retryable` 写成括号形态（暗示 true）；
 * 但 `services/api/src/jobs/sources.ts:180-226` 早已接线（`cancel` 在 `:208`），注册表
 * `services/api/src/jobs/registry.ts:306` 的 `retryable` 真值是 **false**，
 * 测试与 HTTP 面也早已证明 OCR 取消是 200（`tests/unit/ocr-cancel.test.mjs`、
 * `tests/integration/ocr-http.mjs:1972-2043`）。一条假注释会把「某个源悄悄掉 `cancel`」读成设计，
 * 也会把「重试就能好」误导给调用方。本文件把两件事钉住：**六个源都真的提供 `cancel`**，
 * 且**装配点那段注释说的是真话**。
 *
 * 覆盖（逐条可单独指出）：
 * - T1 能力矩阵：`app.ts:2515-2566` 那 6 个 `create*JobSource` 的 `cancel`/`get` 都是函数
 *   （任何源掉 `cancel` ⇒ 红，并打印是哪个源）；
 * - T2 委托与参数：OCR 源的 `cancel` 把 `{userId, jobId, ifMatch, idempotencyKey}` **原样**交给
 *   域内 `cancelJob`（恰好一次；`ifMatch` 不做引号加工——`jobs/routes.ts:71` 透传的就是 HTTP 头原文
 *   `"7"` 这种带引号形态，适配层 `sources.ts:208-216` 逐键直传）；
 * - T3 钩子：域内返回非 null ⇒ `onCancelled` **恰好一次**；返回 `null` 或抛域内 `NOT_FOUND`（⇒ `null`）
 *   ⇒ **零次**；钩子自身失败被吞掉（取消已提交，不回滚、不改响应）；
 * - T4 注册表分工：故意不带 `cancel` 的源 + 作业存在 ⇒ 503 `PROVIDER_UNAVAILABLE`（`retryable: false`，
 *   这正是 `jobs/registry.ts:283-307` 的如实拒绝）；六真源 ⇒ OCR 取消拿到 200 形状；
 * - T5 注释真话：`app.ts` 里紧贴 `createOcrJobSource(` 之前的注释不得再说「`cancel` 不提供」，
 *   不得把 `retryable: false` 写成 `(retryable)` 形态，且必须写明「已提供」/「GY-I10」/200 与证据位置。
 *
 * 边界（如实登记）：本片是**注释订正 + 单元级能力钉子**，不改任何运行时行为——OCR 取消在 HEAD 上
 * 就已经是 200。本文件**不新增** HTTP 端到端读数；HTTP 面的既有证据是
 * `tests/integration/ocr-http.mjs:1972-2043`，本文件不重复造装配。
 *
 * 断言一律先判 `typeof`/键集合再判值；不使用「只要不抛错就算通过」的写法。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiError } from '../../services/api/src/errors.ts';
import { JOB_KINDS, createJobRegistry } from '../../services/api/src/jobs/registry.ts';
import {
  createOcrJobSource,
  createRecognitionJobSource,
  createSynthesisJobSource,
  createTranscriptionJobSource,
} from '../../services/api/src/jobs/sources.ts';
import { createModerationJobSource } from '../../services/api/src/moderation/job-source.ts';
import { createAnswerJobSource } from '../../services/api/src/conversations/job.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_TS = resolve(root, 'services/api/src/app.ts');

const USER = 'user-owner-0001';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const IDEMPOTENCY_KEY = 'w29-cancel-capability-key-000001';
/** HTTP 层的 `If-Match` **原文**就是带引号的形态（`jobs/routes.ts:71` 直接取 `request.headers['if-match']`）。 */
const IF_MATCH = '"7"';

/** 一份**契约合法**的 `Job`（九键、`additionalProperties:false`；默认是取消后的形态）。 */
function contractJob(overrides = {}) {
  return {
    id: JOB_ID,
    revision: 2,
    kind: 'ocr',
    target_ref: { type: 'ocr', id: TARGET_ID, revision: 1 },
    state: 'cancelled',
    deadline_at: '2026-11-01T00:00:00.000Z',
    created_at: '2026-11-01T00:00:00.000Z',
    error_code: null,
    result: null,
    ...overrides,
  };
}

/** 注册表 `cancel` 的入参（与 `jobs/routes.ts:68-73` 交给注册表的形状逐键一致）。 */
function cancelInput() {
  return { userId: USER, jobId: JOB_ID, ifMatch: IF_MATCH, idempotencyKey: IDEMPOTENCY_KEY };
}

/**
 * 按 `app.ts:2515-2566` 的**同序同参**造六个真源（各域服务用最小假件替换；只替换被调用的方法）。
 * 返回 `[{ label, source }]`，顺序即装配顺序：识别 / 转写 / 审核 / 合成 / OCR / 文字问答。
 */
function buildSources(overrides = {}) {
  return [
    {
      label: 'recognition',
      source: createRecognitionJobSource({
        async getJob() {
          return null;
        },
        async cancelJob() {
          return null;
        },
        ...overrides.recognition,
      }),
    },
    {
      label: 'transcription',
      source: createTranscriptionJobSource({
        async getJob() {
          return null;
        },
        async cancelJob() {
          return null;
        },
        ...overrides.transcription,
      }),
    },
    {
      label: 'moderation',
      source: createModerationJobSource({
        taskByJobId() {
          return null;
        },
        async cancelJob() {
          return null;
        },
        ...overrides.moderation,
      }),
    },
    {
      label: 'synthesis',
      source: createSynthesisJobSource({
        async inspectJob() {
          return null;
        },
        async cancelJob() {
          return null;
        },
        ...overrides.synthesis,
      }),
    },
    {
      label: 'ocr',
      source: createOcrJobSource(
        {
          async getJob() {
            return null;
          },
          async cancelJob() {
            return null;
          },
          ...overrides.ocr,
        },
        overrides.ocrHooks ?? {},
      ),
    },
    {
      label: 'answer',
      source: createAnswerJobSource({
        async findByJobId() {
          return null;
        },
        async cancelJob() {
          return null;
        },
        ...overrides.answer,
      }),
    },
  ];
}

// ---------------------------------------------------------------- T1 能力矩阵

test('T1 能力矩阵：六个作业源都提供 get 与 cancel（掉一个就红，并指明是哪个源）', () => {
  const sources = buildSources();
  assert.equal(sources.length, 6, '`app.ts` 的 `createJobRegistry([...])` 必须仍是 6 个源');

  const missing = [];
  for (const { label, source } of sources) {
    assert.equal(source.kind, label, `装配顺序里的第 ${label} 个源 kind 必须是 ${label}，实际 ${source.kind}`);
    if (typeof source.get !== 'function') missing.push(`${label}.get`);
    if (typeof source.cancel !== 'function') {
      missing.push(`${label}.cancel（注册表会把它读成「该域没有取消能力」⇒ 503 PROVIDER_UNAVAILABLE）`);
    }
  }
  assert.deepEqual(missing, [], `这些源掉了取消/读面能力：${missing.join('、')}`);

  // 六个 kind 必须恰好覆盖契约闭集：少一个源同样是「悄悄掉能力」。
  assert.deepEqual(
    sources.map((entry) => entry.source.kind).sort(),
    [...JOB_KINDS].sort(),
    '六个作业源的 kind 必须恰好覆盖契约 Job.kind 闭集',
  );
});

// ---------------------------------------------------------------- T2 委托与参数

test('T2 委托与参数：OCR 源的 cancel 把 ifMatch/idempotencyKey 原样交给域内 cancelJob（恰好一次）', async () => {
  const calls = [];
  const job = contractJob();
  const source = createOcrJobSource({
    async getJob() {
      return null;
    },
    async cancelJob(input) {
      calls.push(input);
      return job;
    },
  });

  const out = await source.cancel(cancelInput());

  assert.equal(calls.length, 1, `域内 cancelJob 必须恰好被调用一次，实际 ${calls.length} 次`);
  assert.deepEqual(
    calls[0],
    { userId: USER, jobId: JOB_ID, ifMatch: IF_MATCH, idempotencyKey: IDEMPOTENCY_KEY },
    '逐键必须原样透传（ifMatch 保留 HTTP 头的引号形态，适配层不做加工）',
  );
  assert.deepEqual(Object.keys(calls[0]).sort(), ['idempotencyKey', 'ifMatch', 'jobId', 'userId'], '只透传四个键，不夹带额外字段');
  assert.equal(out, job, '返回值就是域内 cancelJob 的返回值（适配层不再包一层）');
});

// ---------------------------------------------------------------- T3 钩子

test('T3 钩子：域内返回非 null ⇒ onCancelled 恰好一次；返回 null / 域内 NOT_FOUND ⇒ 零次', async () => {
  const job = contractJob();

  // ① 非 null ⇒ 恰好一次，且只带 {jobId, userId}（与识别源同形，不夹带 If-Match/幂等键）。
  const fired = [];
  const wired = createOcrJobSource(
    {
      async getJob() {
        return null;
      },
      async cancelJob() {
        return job;
      },
    },
    {
      async onCancelled(input) {
        fired.push(input);
      },
    },
  );
  assert.equal(await wired.cancel(cancelInput()), job, '取消结果必须原样返回');
  assert.equal(fired.length, 1, `onCancelled 必须恰好被调用一次，实际 ${fired.length} 次`);
  assert.deepEqual(fired[0], { jobId: JOB_ID, userId: USER }, '钩子收到的必须是 {jobId, userId}');

  // ② 域内返回 null（不存在/越权）⇒ 零次。
  const skipped = [];
  const nullSource = createOcrJobSource(
    {
      async getJob() {
        return null;
      },
      async cancelJob() {
        return null;
      },
    },
    {
      async onCancelled(input) {
        skipped.push(input);
      },
    },
  );
  assert.equal(await nullSource.cancel(cancelInput()), null, '域内返回 null ⇒ 适配层返回 null');
  assert.deepEqual(skipped, [], '返回 null 时不得调钩子（没有取消可记）');

  // ③ 域内抛 NOT_FOUND ⇒ 适配层折算成 null，同样零次。
  const notFoundSource = createOcrJobSource(
    {
      async getJob() {
        return null;
      },
      async cancelJob() {
        throw new ApiError('NOT_FOUND', '作业不存在');
      },
    },
    {
      async onCancelled(input) {
        skipped.push(input);
      },
    },
  );
  assert.equal(await notFoundSource.cancel(cancelInput()), null, '域内 NOT_FOUND ⇒ 适配层必须返回 null（同形 404 口径）');
  assert.deepEqual(skipped, [], '域内 NOT_FOUND 时不得调钩子');

  // ④ 钩子自身失败不得改变取消结果（取消已提交：不回滚、不改写成失败响应）。
  const failingHook = createOcrJobSource(
    {
      async getJob() {
        return null;
      },
      async cancelJob() {
        return job;
      },
    },
    {
      async onCancelled() {
        throw new Error('取消墓碑写入失败');
      },
    },
  );
  assert.equal(await failingHook.cancel(cancelInput()), job, '钩子异常必须被吞掉（.catch(() => {})），取消结果原样返回');
});

// ---------------------------------------------------------------- T4 注册表分工

test('T4 注册表分工：无 cancel 的源 ⇒ 503 PROVIDER_UNAVAILABLE(retryable:false)；六真源 ⇒ OCR 取消 200 形状', async () => {
  // ① 故意不带 `cancel`：注册表必须先确认作业存在，再如实 503（不伪造 cancelled、不谎称不存在）。
  const sourceWithoutCancel = {
    kind: 'ocr',
    async get() {
      return contractJob({ state: 'queued', revision: 4 });
    },
  };
  const bare = createJobRegistry([sourceWithoutCancel]);
  await assert.rejects(bare.cancel(cancelInput()), (error) => {
    assert.equal(error?.name, 'ApiError', `应抛 ApiError，实际 ${error?.name}`);
    assert.equal(error?.code, 'PROVIDER_UNAVAILABLE', `错误码应为 PROVIDER_UNAVAILABLE，实际 ${error?.code}`);
    assert.equal(error?.status, 503, `状态应为 503，实际 ${error?.status}`);
    assert.equal(
      error?.retryable,
      false,
      'retryable 必须是 false（接线是运维/发版动作，原样重试不会成功）—— 这条真值必须与 app.ts 注释一致',
    );
    assert.ok(error.message.includes('尚未提供取消'), `message 应说明能力未接线，实际：${error.message}`);
    return true;
  });

  // ② 六真源：OCR 作业取消不再落进那条 503 分支，而是拿到 200 形状（state=cancelled、revision 恰好 +1）。
  const sources = buildSources({
    ocr: {
      async cancelJob() {
        return contractJob({ state: 'cancelled', revision: 5 });
      },
    },
  });
  const registry = createJobRegistry(sources.map((entry) => entry.source));
  assert.deepEqual([...registry.kinds].sort(), [...JOB_KINDS].sort(), '注册表必须登记满 6 个 kind');

  const cancelled = await registry.cancel(cancelInput());
  assert.equal(typeof cancelled, 'object', 'cancel 必须返回 Job 对象（而不是抛 503）');
  assert.equal(cancelled.kind, 'ocr', `取消的 kind 必须是 ocr，实际 ${cancelled.kind}`);
  assert.equal(cancelled.state, 'cancelled', `取消后 state 必须是 cancelled，实际 ${cancelled.state}`);
  assert.equal(cancelled.revision, 5, `revision 必须恰好 +1（4 → 5），实际 ${cancelled.revision}`);
  assert.equal(cancelled.result, null, 'cancelled 不得携带 result');
  assert.equal(cancelled.error_code, null, 'cancelled 不是错误，不得带 error_code');
});

// ---------------------------------------------------------------- T5 注释真话

/**
 * 取出 `app.ts` 里紧贴 `createOcrJobSource(` 装配行**之前**的连续 `//` 注释块。
 * 注释被整段删掉同样算「没留下真话」⇒ 这里要求至少一行，并由断言 T5 判内容。
 */
function ocrSourceComment(text) {
  const lines = text.split(/\r?\n/);
  const anchor = lines.findIndex((line) => line.includes('createOcrJobSource('));
  assert.notEqual(anchor, -1, 'app.ts 里必须仍能找到 `createOcrJobSource(` 装配行');
  const block = [];
  for (let index = anchor - 1; index >= 0; index -= 1) {
    if (!/^\s*\/\//.test(lines[index])) break;
    block.unshift(lines[index]);
  }
  assert.ok(block.length > 0, '`createOcrJobSource(` 之前必须仍有一段注释（整段删掉同样是「没留下真话」）');
  return { block, comment: block.join('\n'), startLine: anchor - block.length + 1 };
}

test('T5 注释真话：OCR 源那段注释必须说「已提供」，不得再说「不提供」或把 retryable:false 写成 (retryable)', () => {
  const { comment, startLine } = ocrSourceComment(readFileSync(APP_TS, 'utf8'));
  const where = `services/api/src/app.ts:${startLine} 起的 OCR 作业源注释`;

  // ① 不得再出现的假话。拆成两条，红的时候能一眼看出是「旧结论」还是「retryable 写反」。
  assert.ok(
    !/`cancel`\s*\*\*不提供\*\*/.test(comment),
    `${where} 仍写着「\`cancel\` **不提供**」，与 jobs/sources.ts:208 的 \`cancel\` 实现及 200 的既有证据相反`,
  );
  assert.ok(!comment.includes('不提供'), `${where} 仍断言「不提供」；OCR 源的取消能力已接线（GY-I10 取消片）`);

  // ② 注册表那条 503 分支的真值是 `retryable: false`（jobs/registry.ts:306）；括号形态是第二处假话。
  assert.ok(
    !/\(\s*`?retryable`?\s*\)/.test(comment),
    `${where} 把注册表 503 分支的 retryable 写成括号形态；真值是 \`retryable: false\`（jobs/registry.ts:299-306，接线是发版动作、重试不会成功）`,
  );
  assert.match(
    comment,
    /retryable`?[^\n]{0,16}false/,
    `${where} 必须写出 retryable 为 false（503 分支只对 source.cancel === undefined 的源生效，且重试不会成功）`,
  );

  // ③ 必须说出的真话（每条对应派单 §2.1 的一项要求）。
  assert.ok(comment.includes('已提供'), `${where} 必须写明 \`cancel\` **已提供**`);
  assert.ok(comment.includes('GY-I10'), `${where} 必须写明取消能力的来源（GY-I10 取消片）`);
  assert.ok(comment.includes('cancelJob'), `${where} 必须点名语义来源 ocr/service.ts 的 cancelJob`);
  assert.ok(comment.includes('/jobs/{id}/cancel'), `${where} 必须点名受影响的端点 POST /jobs/{id}/cancel`);
  assert.ok(comment.includes('409'), `${where} 必须写明终态再取消是 409`);
  assert.ok(comment.includes('OBJECT_UNAVAILABLE'), `${where} 必须写明终态再取消的错误码 OBJECT_UNAVAILABLE`);
  assert.ok(comment.includes('200'), `${where} 必须写明 POST /jobs/{id}/cancel 对 OCR 作业已由 503 变为 200`);
  assert.ok(comment.includes('503'), `${where} 必须写明接线前的 503 形态（否则读者不知道「已由 503 变为 200」指什么）`);

  // ④ 证据位置必须写进注释（否则下一位读者无从复核）。
  assert.ok(comment.includes('tests/unit/ocr-cancel.test.mjs'), `${where} 必须给出域内证据 tests/unit/ocr-cancel.test.mjs`);
  assert.ok(comment.includes('tests/integration/ocr-http.mjs'), `${where} 必须给出 HTTP 证据 tests/integration/ocr-http.mjs`);
  assert.ok(comment.includes('1972-2043'), `${where} 的 HTTP 证据必须带行号范围 1972-2043`);
});
