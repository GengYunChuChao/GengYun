/**
 * W45 片：`publish` 的**下架闸门前必须回填持久台账的下架集合**（跨进程重启）。
 *
 * 被修的缺陷（与 W43 的 `ledger-pg.ts` 回填配对）：`createPostgresModerationLedger` 的内层是一个
 * **新的**内存台账，`isWithdrawn` 只读内存；而 `service.ts` 的下架闸门
 * （`publish` 里 `:939` 的 `TARGET_WITHDRAWN`、回调侧 `:1287` 的 `CALLBACK_TARGET_WITHDRAWN`）
 * **只问内存**。进程重启后内存为空 ⇒ 库里明明有 `public.moderation_withdrawals` 行，
 * `publish` 的闸门仍然答"没下架" ⇒ 已下架的版本被重新翻成 `published`（下架本该是终态）。
 * `flush()` 会先回填，但它在旧位置的调用点在闸门**之后**（翻可见性之前那一处），
 * 也就是说：闸门先看空集合放行，回填后才发现"这版本下架过"——为时已晚。
 *
 * 本文件判四件事（T1–T4）：
 *   T1（本片核心）**重启后第一个动作就是 publish**：持久台账尚未回填（`withdrawalsHydrated=false`）、
 *      库里有该 `(type,id,revision)` 的下架行 ⇒ `publish` 必须抛 `OBJECT_UNAVAILABLE`，
 *      `details` 里带 `reason_codes=TARGET_WITHDRAWN`，且**零可见性写入**。
 *      改前此例会红成"发布成功"——这正是缺陷本身。
 *   T2 内存台账**不回归**：没有 `flush` 的台账上 `flushLedger()` 是空操作，送审后照旧能发布，
 *      `isWithdrawn` 恒 `false`（内存下架集合本来就是全的）。
 *   T3 fail-closed：回填查询打库就失败 ⇒ 发布**不得成功**、`setVisibility` 写计数 === 0。
 *      两条支路各一读：通用存储失败（`ECONNREFUSED`）⇒ `PROVIDER_UNAVAILABLE`；
 *      `57014`（statement_timeout）⇒ `PROVIDER_TIMEOUT`（`ledgerFailure` 的既有映射，
 *      与 `messages/store-pg.ts` 同口径——**不是** `PROVIDER_UNAVAILABLE`，按实测登记）。
 *   T4 回填**只做一次**：两次 `publish` 只发一次 `SELECT … FROM public.moderation_withdrawals`。
 *
 * 声明：只用**记录型假池**（记录 SQL 与参数；只认回填/建行/退位/读回这几条语句），
 * 不连真库。真库臂是 `tests/integration/moderation-full-chain-pg.mjs` 的 `[R]` 节。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresModerationLedger } from '../../services/api/src/moderation/ledger-pg.ts';
import { createSubstituteContentAuthority } from '../../services/api/src/moderation/visibility.ts';
import {
  USER_A,
  countingPort,
  makeHarness,
  seedAuthority,
  textContent,
} from '../moderation/_http-fixtures.mjs';

const TS = '2026-10-14T03:00:00.000Z';
const TARGET = Object.freeze({ type: 'post', id: 'post-1001', revision: 1 });
const CONTENT = textContent();

/** 库里的一行下架标记（`public.moderation_withdrawals` 的三列主键）。 */
function withdrawalRow(target = TARGET) {
  return { target_type: target.type, target_id: target.id, target_revision: target.revision };
}

/**
 * 记录型假池：只有回填、下架写入、建行/退位/读回这几条通路。
 * `options.armed` 非空时**回填那条 SELECT** 抛指定错误码（模拟库不可用/语句超时）。
 */
function makePool(options = {}) {
  const calls = [];
  const state = {
    armed: options.armed ?? null,
    withdrawals: (options.withdrawals ?? []).map((row) => ({ ...row })),
    decisions: new Map(),
    /** 回填 SELECT 的次数（T4 的读数）。 */
    hydrate_reads: 0,
    /** `INSERT INTO public.moderation_withdrawals` 的次数（拒绝路径必须为 0）。 */
    withdrawal_writes: 0,
  };
  const pool = {
    async query(text, values) {
      const sql = String(text).trim();
      calls.push(sql);
      const args = values ?? [];
      if (/FROM public\.moderation_withdrawals\b/u.test(sql)) {
        state.hydrate_reads += 1;
        if (state.armed !== null) {
          const spec = state.armed;
          throw Object.assign(new Error(spec.message ?? 'connect ECONNREFUSED'), { code: spec.code ?? 'ECONNREFUSED' });
        }
        return { rows: state.withdrawals.map((row) => ({ ...row })) };
      }
      if (/^INSERT INTO public\.moderation_withdrawals/u.test(sql)) {
        state.withdrawal_writes += 1;
        state.withdrawals.push({ target_type: args[0], target_id: args[1], target_revision: args[2] });
        return { rows: [] };
      }
      if (/^INSERT INTO public\.moderation_decisions/u.test(sql)) {
        const jobId = args[0];
        if (!state.decisions.has(jobId)) {
          state.decisions.set(jobId, { job_id: jobId, superseded: args[23] === true, state: args[8] });
        }
        return { rows: [] };
      }
      if (/^UPDATE public\.moderation_decisions\s+SET superseded = TRUE/u.test(sql)) return { rows: [] };
      if (/^UPDATE public\.moderation_decisions SET state =/u.test(sql)) {
        const row = state.decisions.get(args[0]);
        if (row === undefined) return { rows: [] };
        row.state = args[1];
        return { rows: [{ job_id: args[0] }] };
      }
      if (/^SELECT superseded FROM public\.moderation_decisions/u.test(sql)) {
        const row = state.decisions.get(args[0]);
        return { rows: row === undefined ? [] : [{ superseded: row.superseded }] };
      }
      // 任何别的语句都说明这条路径跑出了本用例的假设范围：宁可炸，不许静默放过。
      throw new Error(`假池不认这条语句：${sql.slice(0, 120)}`);
    },
  };
  return { pool, calls, state };
}

/** 与真池同形的最小包装：只记 `setVisibility` / `setPublishedRevision` 两次写面的调用。 */
function observingAuthority(inner) {
  const writes = [];
  return {
    origin: inner.origin,
    writes,
    read: (target) => inner.read(target),
    publishedRevision: (target) => inner.publishedRevision(target),
    seed: (target, snapshot) => inner.seed(target, snapshot),
    get: (target) => inner.get(target),
    async setVisibility(target, visibility) {
      writes.push({ op: 'setVisibility', target: { ...target }, visibility });
      return inner.setVisibility(target, visibility);
    },
    async setPublishedRevision(target, revision) {
      writes.push({ op: 'setPublishedRevision', target: { ...target }, revision });
      return inner.setPublishedRevision(target, revision);
    },
  };
}

/**
 * 造一条**真的** approved 记录：在内存台账上跑一次完整送审（规则 + 模型两关都过），
 * 再把记录原样搬进被测的持久台账。搬运用 `ledger.create(record)`——它只入队、**不触发回填**，
 * 于是"进程刚重启、回填还没发生"这个现场可以精确复现（这是 T1 的前提）。
 */
async function approvedRecord() {
  const tms = countingPort('tms');
  const h = makeHarness({ ports: { tms: tms.port } });
  await h.service.submitScreening({ actor: USER_A, content: CONTENT });
  const record = h.ledger.current(TARGET, 'text');
  assert.ok(record !== null, '前提：送审在内存台账里留下了任务记录');
  assert.equal(record.state, 'succeeded', '前提：送审已跑完（终态 succeeded）');
  assert.equal(record.decision, 'approved', '前提：合成端口给出 approved（否则后续闸门会先撞 DECISION_NOT_APPROVED）');
  return { record, port: tms.port };
}

/** 跑一次动作，把"成功/抛错"都收成数据（断言消息里能如实写出实际结果）。 */
async function settle(run) {
  try {
    return { value: await run(), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function actualText(outcome) {
  if (outcome.error !== null) {
    const codes = (outcome.error.details ?? []).map((item) => item.code).join(',');
    return `抛 ${outcome.error.code}${codes.length > 0 ? `（${codes}）` : ''}：${outcome.error.message}`;
  }
  return `发布成功：${JSON.stringify(outcome.value)}`;
}

function reasonCodes(error) {
  return (error?.details ?? []).filter((item) => item.field === 'reason_codes').map((item) => item.code);
}

test('T1. 重启后第一个动作是 publish：库里已下架 ⇒ OBJECT_UNAVAILABLE + TARGET_WITHDRAWN，零可见性写入', async () => {
  const { record, port } = await approvedRecord();
  const { pool, state } = makePool({ withdrawals: [withdrawalRow(TARGET)] });
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  // 重启前定下的结论原样落在台账里（这一步只入队，不打回填那条 SELECT）。
  ledger.create(record);
  assert.equal(ledger.withdrawalsHydrated, false, '前提：这份台账还没回填（= 进程刚重启）');
  assert.equal(state.hydrate_reads, 0, '前提：create() 不得触发回填');
  assert.equal(ledger.isWithdrawn(TARGET), false, '前提：回填前 isWithdrawn 一律答 false（缺陷入口就在这）');

  const authority = observingAuthority(createSubstituteContentAuthority());
  seedAuthority(authority, TARGET, { visibility: 'private' });
  const h = makeHarness({ ledger, ports: { tms: port }, authority });

  const outcome = await settle(() => h.service.publish({ actor: USER_A, content: CONTENT }));

  assert.equal(
    outcome.error?.code,
    'OBJECT_UNAVAILABLE',
    `库里有下架行时不得发布；实际：${actualText(outcome)}`,
  );
  assert.deepEqual(reasonCodes(outcome.error), ['TARGET_WITHDRAWN'], `原因码必须是 TARGET_WITHDRAWN；实际：${actualText(outcome)}`);
  assert.deepEqual(authority.writes, [], '拒绝路径不得写可见性（不得出现半发布）');
  assert.equal(state.withdrawal_writes, 0, '拒绝路径不得写新的下架行');
  assert.equal(ledger.withdrawalsHydrated, true, '走到闸门之前必须已经回填过（否则闸门问的是空集合）');
});

test('T2. 内存台账不回归：没有 flush 的台账上 flushLedger() 是空操作，照旧可发布', async () => {
  const tms = countingPort('tms');
  const h = makeHarness({ ports: { tms: tms.port } });
  seedAuthority(h.authority, TARGET, { visibility: 'private' });

  assert.equal(h.ledger.flush, undefined, '前提：内存台账没有 flush（`flushLedger()` 的 `undefined` 早退就是为它留的）');
  await h.service.submitScreening({ actor: USER_A, content: CONTENT });

  const outcome = await settle(() => h.service.publish({ actor: USER_A, content: CONTENT }));
  assert.equal(outcome.error, null, `内存台账上必须照旧发布成功；实际：${actualText(outcome)}`);
  assert.equal(outcome.value.published, true);
  assert.equal(outcome.value.published_revision, TARGET.revision);
  assert.deepEqual(outcome.value.reason_codes, []);
  assert.equal(h.ledger.isWithdrawn(TARGET), false, '内存台账：从未下架 ⇒ isWithdrawn 恒 false');
});

test('T3. fail-closed：回填查询失败 ⇒ 发布不得成功、零可见性写入（两条错误码支路）', async () => {
  const { record, port } = await approvedRecord();
  const branches = [
    { label: '通用存储失败', armed: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:5432' }, expected: 'PROVIDER_UNAVAILABLE' },
    { label: '语句超时', armed: { code: '57014', message: 'canceling statement due to statement timeout' }, expected: 'PROVIDER_TIMEOUT' },
  ];
  // 两条支路**各自独立跑完再汇总**：若第一支路一红就中断循环，第二条等于没测，
  // 而 N3 负控制要证明的恰恰是"两条都红"。
  const failures = [];
  for (const branch of branches) {
    try {
      const { pool, state } = makePool({ armed: branch.armed, withdrawals: [withdrawalRow(TARGET)] });
      const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
      ledger.create(record);
      assert.equal(ledger.withdrawalsHydrated, false, `前提（${branch.label}）：还没回填`);

      const authority = observingAuthority(createSubstituteContentAuthority());
      seedAuthority(authority, TARGET, { visibility: 'private' });
      const h = makeHarness({ ledger, ports: { tms: port }, authority });

      const outcome = await settle(() => h.service.publish({ actor: USER_A, content: CONTENT }));
      assert.equal(
        outcome.error?.code,
        branch.expected,
        `${branch.label}：回填失败必须拒绝发布（${branch.expected}）；实际：${actualText(outcome)}`,
      );
      assert.match(outcome.error.message, /回填/u, `${branch.label}：文案必须点明「回填」，与写面失败区分`);
      assert.deepEqual(authority.writes, [], `${branch.label}：回填失败时不得写可见性（发布未发生）`);
      assert.equal(state.withdrawal_writes, 0, `${branch.label}：不得写新的下架行`);
      // `hydrate()` 自带"重试一次"（`ledger-pg.ts`：存储可能刚恢复，再失败才如实抛出），
      // 所以一次 publish 里失败回填会打两次库；这里只钉"确实去打了库"与"没有第三次"。
      assert.equal(state.hydrate_reads, 2, `${branch.label}：一次 publish 只打一次回填（内部重试一次，共 2 条 SELECT）`);
    } catch (error) {
      failures.push(`${branch.label}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(failures, [], `两条支路都必须 fail-closed，红在：${failures.join(' ／ ')}`);
});

test('T4. 回填只做一次：两次 publish 只发一次 SELECT … FROM public.moderation_withdrawals', async () => {
  const { record, port } = await approvedRecord();
  const { pool, state } = makePool({ withdrawals: [withdrawalRow(TARGET)] });
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  ledger.create(record);

  const authority = observingAuthority(createSubstituteContentAuthority());
  seedAuthority(authority, TARGET, { visibility: 'private' });
  const h = makeHarness({ ledger, ports: { tms: port }, authority });

  const first = await settle(() => h.service.publish({ actor: USER_A, content: CONTENT }));
  assert.equal(first.error?.code, 'OBJECT_UNAVAILABLE', `第一次发布必须被拒；实际：${actualText(first)}`);
  assert.equal(state.hydrate_reads, 1, '第一次发布必须回填一次');
  assert.equal(ledger.withdrawalsHydrated, true);

  const second = await settle(() => h.service.publish({ actor: USER_A, content: CONTENT }));
  assert.equal(second.error?.code, 'OBJECT_UNAVAILABLE', `第二次发布仍必须被拒；实际：${actualText(second)}`);
  assert.deepEqual(reasonCodes(second.error), ['TARGET_WITHDRAWN']);
  assert.equal(state.hydrate_reads, 1, '第二次发布不得重新回填（回填是惰性一次性的）');
  assert.deepEqual(authority.writes, [], '两次都不得写可见性');
  assert.equal(state.withdrawal_writes, 0);
});
