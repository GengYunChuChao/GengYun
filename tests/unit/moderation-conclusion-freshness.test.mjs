/**
 * GY-R72 W54 · 审核**结论新鲜度**跨重启（迁移 `0052` + 只读事实端口）
 *
 * 被钉的缺陷：`readView` 的 `staleReasons` 原先只从**内存**台账派生
 * （`service.ts` 的 `ledger.forRevision(target)`），而 PG 台账的决策是「存量任务行不回填」
 * （`moderation/ledger-pg.ts` 的 `## 下架集合回填，任务结论仍不回填（W43）` 一节）⇒
 * 进程一重启、内存空 ⇒ `staleReasons` 恒空 ⇒ `RESCREEN_REQUIRED` 永不触发。
 *
 * 本片做法：内存**有**结论时按内存算（原逻辑一字未动）；内存**为空才**问只读事实端口
 * （`moderation/conclusion-facts.ts` 的 `conclusionStaleReasonsOf`）；两者都空 / 端口缺席 /
 * 端口抛错 ⇒ 空数组 ⇒ 维持改前的 `stale:false`。
 *
 * ⛔ 本文件同时钉死**可见性零变化**：端口只喂 `RESCREEN_REQUIRED` 一个分支，
 * `present` / `effectiveState` / 社区读面一个符号都不碰（T6）。
 *
 * 证据边界：全部输入是合成夹具（假池返回构造行），**不是**真库证据；真库臂在
 * `tests/integration/moderation-ledger-pg.mjs`（CI 跑，本机 pg 不可用）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createModerationLedger } from '../../services/api/src/moderation/decisions.ts';
import { createPostgresConclusionFacts } from '../../services/api/src/moderation/conclusion-facts-pg.ts';
import {
  RULE_VERSION_CURRENT,
  TEXT_PROMPT_VERSION,
  USER_A,
  countingPort,
  makeHarness,
  seedAuthority,
  textContent,
} from '../moderation/_http-fixtures.mjs';

const TARGET_V1 = { type: 'post', id: 'post-1001', revision: 1 };
const CONCLUDED_AT = '2026-11-02T01:02:03.000Z';

/** 源文件按 URL 读（测试不受 cwd 影响）。 */
function sourceOf(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

/** 剥掉 `/* … *\/` 与整行注释（`//` 与 SQL 的 `--`）：结构断言只看可执行文本，不被注释里的字眼误导。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*(?:\/\/|--).*$/gmu, '');
}

/**
 * 记录型假池：只回答「定向查询」，并把每次调用记下来（用于断言"端口真的问过库"）。
 *
 * `rows` 的每一项形如 `{ target: {type,id,revision}, row: {...列} }`；
 * `error` 非空时 `query` 直接抛（模拟缺表 / 缺列 / 42501 / 连接失败）。
 */
function stubPool(entries, options = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      if (options.error !== undefined) throw options.error;
      const [type, id, revision] = values;
      const rows = entries
        .filter((entry) => entry.target.type === type && entry.target.id === id && entry.target.revision === revision)
        .map((entry) => entry.row);
      return { rows };
    },
  };
}

/** 一条「已落库的通过结论」行（列名与 `moderation_decisions` 的读面列逐字一致）。 */
function approvedRow(overrides = {}) {
  return {
    content_kind: 'text',
    decision: 'approved',
    rule_version: RULE_VERSION_CURRENT,
    model_version: 'synthetic-tms-model@1.0',
    prompt_version: TEXT_PROMPT_VERSION,
    concluded_at: CONCLUDED_AT,
    ...overrides,
  };
}

/** 跑一次「提交 + 发布」，拿到发布后的任务记录（含当时的三条版本）。 */
async function publishOnce(harness) {
  const content = textContent();
  seedAuthority(harness.authority, TARGET_V1, { visibility: 'private', owner_id: USER_A.userId });
  await harness.service.submitScreening({ actor: USER_A, content });
  await harness.service.publish({ actor: USER_A, content });
  const approved = harness.ledger.forRevision(TARGET_V1).filter((task) => task.decision === 'approved');
  assert.equal(approved.length >= 1, true, '前提：发布后内存台账里有一条 approved 结论');
  return approved[0];
}

// ---------------------------------------------------------------------------
// T1 迁移形状：加列 + 索引 + 只回填 approved 的空值行
// ---------------------------------------------------------------------------

test('T1 迁移 0052 形状：可空 concluded_at + 读面索引 + 只回填 approved 的空值行（零 GRANT）', () => {
  const forward = sourceOf('services/api/db/migrations/0052_moderation_conclusion_facts.sql');
  const rollback = sourceOf('services/api/db/migrations/rollback/0052_moderation_conclusion_facts.down.sql');

  assert.match(
    forward,
    /ALTER TABLE public\.moderation_decisions\s+ADD COLUMN IF NOT EXISTS concluded_at timestamptz;/u,
    '必须给 moderation_decisions 加一列可空 timestamptz（NULL = 没有结论/时刻未知）',
  );
  assert.match(
    forward,
    /CREATE INDEX IF NOT EXISTS moderation_decisions_target_concluded_idx\s+ON public\.moderation_decisions \(target_type, target_id, target_revision, concluded_at DESC\);/u,
    '读面索引必须是 (target_type, target_id, target_revision, concluded_at DESC) —— 前三列等值、第四列定序',
  );
  assert.match(
    forward,
    /UPDATE public\.moderation_decisions\s+SET concluded_at = updated_at\s+WHERE decision = 'approved'\s+AND concluded_at IS NULL;/u,
    '回填必须同时带 decision = approved 与 concluded_at IS NULL 两个条件（不臆造、可重跑）',
  );
  // 下面两条只看**可执行文本**（头注释里会解释回滚怎么做，那不是正向迁移的动作）。
  const forwardCode = stripComments(forward);
  assert.equal(
    /^\s*GRANT\b/mu.test(forwardCode),
    false,
    '本迁移零 GRANT（与 0024/0026/0051 同一纪律）；列级授权只改 20-login-roles.sql 段 M3',
  );
  assert.equal(
    /\bDROP\b/u.test(forwardCode),
    false,
    '正向迁移不得自带拆除语句（拆除只在 rollback 文件里）',
  );

  assert.match(rollback, /DROP INDEX IF EXISTS public\.moderation_decisions_target_concluded_idx;/u, '回滚先拆索引');
  assert.match(
    rollback,
    /ALTER TABLE public\.moderation_decisions\s+DROP COLUMN IF EXISTS concluded_at;/u,
    '回滚再拆列（可重算派生值、非证据 ⇒ 不用 G 码预检）',
  );
});

// ---------------------------------------------------------------------------
// T2 重启后仍算得出（本片的核心；改前必红）
// ---------------------------------------------------------------------------

test('T2 重启（内存台账为空）后仍算得出过期：端口的事实 + 前进的模型版本 ⇒ RESCREEN_REQUIRED', async () => {
  const before = makeHarness({ ports: { tms: countingPort('tms').port } });
  const published = await publishOnce(before);
  assert.equal(published.decision, 'approved');
  assert.equal(published.model_version, 'synthetic-tms-model@1.0');

  // 重启：**同一个权威**、一个全新的内存台账（空）+ 端口从库里的回填行回答事实。
  const pool = stubPool([{ target: TARGET_V1, row: approvedRow() }]);
  const warnings = [];
  const restarted = makeHarness({
    ledger: createModerationLedger(),
    authority: before.authority,
    ports: { tms: countingPort('tms', { model_version: 'synthetic-tms-model@2.0' }).port },
    conclusionFacts: createPostgresConclusionFacts({ pool, warn: (line) => warnings.push(line) }),
  });

  // 前提：重启后内存确实空了 —— 这正是改前 `staleReasons` 恒空的原因。
  assert.deepEqual(await restarted.service.tasks(TARGET_V1), [], '前提：新进程的内存台账里没有任何结论');
  assert.equal(restarted.cache.size(), 0);

  const view = await restarted.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(pool.calls.length, 1, '内存为空时必须真的去问一次库（不是"什么都不做就放行"）');
  assert.deepEqual(pool.calls[0].values, ['post', 'post-1001', 1], '查询必须按目标三元组定向，不许全表扫');
  assert.equal(warnings.length, 0, '前提：正常路径不记 warn');
  assert.equal(view.visible, false, '重启后模型版本已前进 ⇒ 旧结论不得再当"已审"返回');
  assert.equal(view.reason_codes[0], 'RESCREEN_REQUIRED', '必须显式给出"待重评"');
  assert.ok(
    view.reason_codes.includes('MODEL_VERSION_CHANGED'),
    `原因里必须能看到是哪一维版本变了（现场 ${JSON.stringify(view.reason_codes)}）`,
  );
});

// ---------------------------------------------------------------------------
// T3 版本对齐 ⇒ 不 stale（且确实问过库，不是碰巧放过）
// ---------------------------------------------------------------------------

test('T3 版本对齐时不 stale：同一份事实、模型版本没动 ⇒ 仍可见且不报 RESCREEN_REQUIRED', async () => {
  const before = makeHarness({ ports: { tms: countingPort('tms').port } });
  await publishOnce(before);

  const pool = stubPool([{ target: TARGET_V1, row: approvedRow() }]);
  const restarted = makeHarness({
    ledger: createModerationLedger(),
    authority: before.authority,
    ports: { tms: countingPort('tms').port },
    conclusionFacts: createPostgresConclusionFacts({ pool }),
  });

  const view = await restarted.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(pool.calls.length, 1, '前提：端口确实被问过（否则这条用例对"少判"没有证明力）');
  assert.equal(view.visible, true, '版本对齐 ⇒ 不得误伤可见性');
  assert.equal(
    view.reason_codes.includes('RESCREEN_REQUIRED'),
    false,
    `版本对齐时不得报待重评（现场 ${JSON.stringify(view.reason_codes)}）`,
  );
});

// ---------------------------------------------------------------------------
// T4 非通过结论（pending / NULL）⇒ 端口交空、读面不 stale
// ---------------------------------------------------------------------------

test('T4 decision 为 NULL 或 pending 的行不算结论：端口交空数组，读面维持 stale:false', async () => {
  const before = makeHarness({ ports: { tms: countingPort('tms').port } });
  await publishOnce(before);

  const pool = stubPool([
    { target: TARGET_V1, row: approvedRow({ decision: 'pending' }) },
    { target: TARGET_V1, row: approvedRow({ decision: null }) },
  ]);
  const warnings = [];
  const port = createPostgresConclusionFacts({ pool, warn: (line) => warnings.push(line) });
  assert.deepEqual(await port.concludedAssessmentsOf(TARGET_V1), [], '非 approved 的行一律不进事实面');

  const restarted = makeHarness({
    ledger: createModerationLedger(),
    authority: before.authority,
    ports: { tms: countingPort('tms', { model_version: 'synthetic-tms-model@2.0' }).port },
    conclusionFacts: port,
  });
  const view = await restarted.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(view.visible, true, '没有可复用的通过结论 ⇒ 不得凭"不知道"改可见性');
  assert.equal(
    view.reason_codes.includes('RESCREEN_REQUIRED'),
    false,
    '非通过结论不构成"结论过期"（与内存口径 task.decision !== approved ⇒ 不 stale 一致）',
  );
  assert.equal(warnings.length >= 1, true, '谓词外的行必须记 warn 而不是猜（谓词被改过时才有这条路）');
});

// ---------------------------------------------------------------------------
// T5 端口抛错 ⇒ 空数组、不抛、读面不 500
// ---------------------------------------------------------------------------

test('T5 端口遇到缺表/缺列/权限不足：返回空数组 + 记一次 warn，绝不抛、绝不 500', async () => {
  const missing = Object.assign(new Error('column "concluded_at" does not exist'), { code: '42703' });
  const pool = stubPool([], { error: missing });
  const warnings = [];
  const port = createPostgresConclusionFacts({ pool, warn: (line) => warnings.push(line) });

  assert.deepEqual(await port.concludedAssessmentsOf(TARGET_V1), [], '缺列 ⇒ 空数组（不是抛错）');
  assert.deepEqual(await port.concludedAssessmentsOf(TARGET_V1), [], '第二次也照样空数组');
  assert.equal(pool.calls.length, 2, '每次调用都会真问一次库（不缓存失败）');
  assert.equal(warnings.length, 1, '同样的失败只记一次 warn（不刷屏）');
  const payload = JSON.parse(warnings[0]);
  assert.equal(payload.event, 'moderation.conclusion_facts.unavailable');
  assert.match(payload.reason, /42703/u, 'warn 里必须带得上失败原因（可定位）');
  assert.equal(payload.consequence, 'stale_reasons_degraded_to_memory_only', '后果必须如实写明：退回内存口径');

  // 读面：拿不到事实 ⇒ 维持改前的 stale:false，不抛、不 500。
  const before = makeHarness({ ports: { tms: countingPort('tms').port } });
  await publishOnce(before);
  const restarted = makeHarness({
    ledger: createModerationLedger(),
    authority: before.authority,
    ports: { tms: countingPort('tms', { model_version: 'synthetic-tms-model@2.0' }).port },
    conclusionFacts: port,
  });
  const view = await restarted.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(typeof view, 'object', '读面必须正常返回（不得 500）');
  assert.equal(view.visible, true, '拿不到事实只允许"少判 stale"，不得凭不知道改可见性');
});

// ---------------------------------------------------------------------------
// T6 可见性零变化（本片最硬的一条）
// ---------------------------------------------------------------------------

test('T6 可见性零变化：端口给 approved 还是给空，读面可见性逐字相同；且端口不接任何可见性符号', async () => {
  // ① 结构：端口两个文件剥掉注释后，不得出现可见性判定的任何符号。
  for (const relative of ['services/api/src/moderation/conclusion-facts.ts', 'services/api/src/moderation/conclusion-facts-pg.ts']) {
    const code = stripComments(sourceOf(relative));
    for (const symbol of ['effectiveState', 'checkReadVisibility', 'present(', 'Visibility']) {
      assert.equal(
        code.includes(symbol),
        false,
        `${relative} 的可执行文本里不得出现 ${symbol}（端口只喂 RESCREEN_REQUIRED，不参与可见性）`,
      );
    }
  }
  // 社区读链（`effectiveState` 所在文件）压根不认识这个端口 —— 这是"一字未动"的结构证据。
  assert.equal(
    /concludedAssessmentsOf|conclusionFacts/u.test(sourceOf('services/api/src/community/service.ts')),
    false,
    'community/service.ts（effectiveState / present 的所在地）不得引用结论事实端口',
  );

  // ② 行为：同一台账/权威下，「端口给 approved 事实」与「端口给空」的读面必须逐字相同。
  const before = makeHarness({ ports: { tms: countingPort('tms').port } });
  await publishOnce(before);
  const aligned = stubPool([{ target: TARGET_V1, row: approvedRow() }]);
  const withFacts = makeHarness({
    ledger: createModerationLedger(),
    authority: before.authority,
    ports: { tms: countingPort('tms').port },
    conclusionFacts: createPostgresConclusionFacts({ pool: aligned }),
  });
  const withEmpty = makeHarness({
    ledger: createModerationLedger(),
    authority: before.authority,
    ports: { tms: countingPort('tms').port },
    conclusionFacts: createPostgresConclusionFacts({ pool: stubPool([]) }),
  });
  const a = await withFacts.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  const b = await withEmpty.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(aligned.calls.length, 1, '前提：带事实那一侧确实问过库');
  assert.deepEqual(a, b, '端口「有事实」与「空」必须产出逐字相同的读面（可见性零变化）');

  // ③ 方向：端口最多只能把可见"变成不可见"，绝不能反过来。
  const hostile = stubPool([{ target: TARGET_V1, row: approvedRow({ model_version: 'synthetic-tms-model@9.9' }) }]);
  const withHostile = makeHarness({
    ledger: createModerationLedger(),
    authority: before.authority,
    ports: { tms: countingPort('tms').port },
    conclusionFacts: createPostgresConclusionFacts({ pool: hostile }),
  });
  const c = await withHostile.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(c.visible, false, '事实与当前版本不符 ⇒ 只降不升（判待重评）');
  assert.equal(c.reason_codes[0], 'RESCREEN_REQUIRED');
  const d = await withEmpty.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(d.visible, true, '对照：空端口时可见 —— 说明上一条的不可见来自版本比对，不是端口本身');
});
