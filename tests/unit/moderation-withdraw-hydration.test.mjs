/**
 * W43 · 持久台账**构造时回填下架集合**（跨进程读回）的单元回归。
 *
 * 被修的缺陷：`createPostgresModerationLedger` 内层是一个**新的**内存台账，`markWithdrawn` 只写库、
 * 从不读库 ⇒ 进程重启后 `isWithdrawn` 一律答 `false`。而 `service.ts` 的两道闸门都只问它
 * （发布前 `:939` 的 `TARGET_WITHDRAWN`、回调闸门 `:1287` 的 `CALLBACK_TARGET_WITHDRAWN`），
 * 于是**一条迟到的旧回调可以把已下架的版本重新翻成 `published`**。
 *
 * 本文件判的六件事（T1–T6）：
 *   T1 回填真的把库里的行搬进内存：`flush()` 之后 `isWithdrawn(库里的行) === true`；
 *   T2 `snapshotCounts().withdrawn` 含回填行（读数不再只反映本进程的下架次数）；
 *   T3 回填**零写**：只发那一条 SELECT，绝不 `INSERT INTO public.moderation_withdrawals`
 *      （回填若顺手回写，会把一次纯读变成写面失败风险，也会让 `isDurable`/`flush` 判据失真）；
 *   T4 SQL 形状钉子：只读三列主键、不得 `SELECT *`、不得读 `withdrawn_by`/`withdrawn_at`
 *      （后两列对运行时角色**没有**列级 SELECT 授权，读了就是 42501）；
 *   T5 回填失败**不得**连坐构造与读面：构造不抛、`withdrawalsHydrated=false`、`isWithdrawn` 仍按内存答；
 *      随后 `hydrate()` 重试成功 ⇒ `withdrawalsHydrated=true` 且集合就位；
 *   T6 持续失败 ⇒ `flush()` 必须拒绝、且文案含「回填」（不许把"没读回下架行"当成"没有下架行"放行）。
 *
 * 声明：只用**记录型假池**（记录 SQL 文本与参数、按表名分派），不连真库。真库臂见
 * `tests/integration/moderation-ledger-pg.mjs` 的 `[H]` 节。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresModerationLedger } from '../../services/api/src/moderation/ledger-pg.ts';

const TS = '2026-10-22T04:00:00.000Z';
const WITHDRAWN_ID = 'aa11bb22-cc33-4d44-8e55-ff6677889900';
const NEVER_ID = 'bb22cc33-dd44-4e55-8f66-aa7788990011';
const TARGET_WITHDRAWN = Object.freeze({ type: 'post', id: WITHDRAWN_ID, revision: 3 });
const TARGET_NEVER = Object.freeze({ type: 'post', id: NEVER_ID, revision: 1 });

/** 库里的下架行（`public.moderation_withdrawals` 的三列主键）。 */
function dbRows() {
  return [{ target_type: 'post', target_id: WITHDRAWN_ID, target_revision: 3 }];
}

/**
 * 记录型假池：只有两条通路——
 *   · `SELECT … FROM public.moderation_withdrawals` ⇒ 回填（`armed` 为真时抛错，模拟存储不可用）；
 *   · 其余语句一律记下来（回填**不许**发写语句，T3 就靠这条判）。
 */
function makePool(options = {}) {
  const calls = [];
  const rows = options.rows ?? dbRows();
  const state = { armed: options.armed === true };
  const pool = {
    async query(text, values) {
      const sql = String(text);
      calls.push({ text: sql, values: values ?? [] });
      if (/FROM public\.moderation_withdrawals/iu.test(sql)) {
        if (state.armed) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        return { rows: rows.map((row) => ({ ...row })) };
      }
      // 回填路径上出现任何别的语句都是缺陷（T3）。
      throw new Error(`回填期间不许发别的语句：${sql.trim().slice(0, 80)}`);
    },
  };
  return { pool, calls, state };
}

test('T1. flush() 先回填：库里的下架行搬进内存，isWithdrawn 跨进程答 true', async () => {
  const { pool, calls } = makePool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  assert.equal(ledger.withdrawalsHydrated, false, '构造时不得声称已回填（惰性：构造不打库）');
  assert.equal(calls.length, 0, '构造不得打库');
  assert.equal(ledger.isWithdrawn(TARGET_WITHDRAWN), false, '回填前只按内存答（此时为空）');

  await ledger.flush();

  assert.equal(ledger.withdrawalsHydrated, true, 'flush 之后必须已回填');
  assert.equal(ledger.isWithdrawn(TARGET_WITHDRAWN), true, '库里的下架行必须能被 isWithdrawn 答出来（本片的核心读数）');
  assert.equal(ledger.isWithdrawn({ ...TARGET_WITHDRAWN, revision: 4 }), false, '下架键含 revision：别的版本不受影响');
  assert.equal(ledger.isWithdrawn(TARGET_NEVER), false, '从没下架过的目标仍然 false');
  assert.ok(
    calls.every((call) => /SELECT/iu.test(call.text)),
    '回填只许发 SELECT（写面语句由 markWithdrawn 负责，回填不该插手）',
  );
});

test('T2. snapshotCounts().withdrawn 含回填行（读数不再只反映本进程的下架次数）', async () => {
  const { pool } = makePool({
    rows: [
      { target_type: 'post', target_id: WITHDRAWN_ID, target_revision: 3 },
      { target_type: 'post', target_id: NEVER_ID, target_revision: 1 },
    ],
  });
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  assert.equal(ledger.snapshotCounts().withdrawn, 0, '回填前 withdrawn 计数为 0');

  await ledger.flush();

  assert.equal(ledger.snapshotCounts().withdrawn, 2, '库里两行 ⇒ 回填后 withdrawn 计数 2');
  assert.equal(ledger.isWithdrawn(TARGET_NEVER), true, '第二行同样进集合（不是只搬第一行）');
});

test('T3. 回填零写：只发那一条 SELECT，绝不 INSERT INTO public.moderation_withdrawals', async () => {
  const { pool, calls } = makePool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });

  await ledger.hydrate();
  await ledger.flush();
  await ledger.flush();

  const selects = calls.filter((call) => /FROM public\.moderation_withdrawals/iu.test(call.text));
  const writes = calls.filter((call) => /^\s*(INSERT|UPDATE|DELETE)\b/iu.test(call.text));
  assert.equal(calls.length, 1, `回填只打一次库（多次 flush 复用同一份回填结果），实际 ${calls.length} 条：${JSON.stringify(calls.map((c) => c.text.trim().slice(0, 40)))}`);
  assert.equal(selects.length, 1, '那一条就是回填 SELECT');
  assert.deepEqual(writes, [], '回填**不得**回写：这些行本来就在库里，再写一遍只会白挨一次写面失败风险');
  assert.deepEqual(selects[0].values, [], '回填 SELECT 无参数（不按目标过滤：一次读全量）');
});

test('T4. SQL 形状钉子：只读三列主键，不得 SELECT *、不得读 withdrawn_by/withdrawn_at', async () => {
  const { pool, calls } = makePool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  await ledger.hydrate();

  const sql = calls[0].text;
  for (const column of ['target_type', 'target_id', 'target_revision']) {
    assert.ok(sql.includes(column), `回填必须读 ${column}（下架键由三列组成）`);
  }
  assert.ok(/FROM public\.moderation_withdrawals/iu.test(sql), '必须读下架表全名（public. 前缀不许省）');
  assert.ok(!/select\s+\*/iu.test(sql), '不得 SELECT *：运行时角色只被授了三列的列级 SELECT');
  for (const unauthorized of ['withdrawn_by', 'withdrawn_at']) {
    assert.ok(!sql.includes(unauthorized), `不得读 ${unauthorized}（未对运行时角色授权，读了就是 42501）`);
  }
  assert.ok(!sql.includes('WHERE'), '回填不看单个目标：一次读全量（按目标过滤等于只回填一个版本）');
});

test('T5. 回填失败不连坐构造与读面：withdrawalsHydrated=false、isWithdrawn 仍答内存；重试成功后集合就位', async () => {
  const { pool, calls, state } = makePool({ armed: true });
  // 构造必须**不抛**：回填是惰性的，构造阶段一次库都不打。
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  assert.equal(calls.length, 0, '构造不打库');
  assert.equal(ledger.withdrawalsHydrated, false);

  await assert.rejects(
    () => ledger.hydrate(),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `实际 ${error.code}：${error.message}`);
      assert.ok(error.message.includes('回填'), `文案必须点明"回填"：${error.message}`);
      return true;
    },
  );
  assert.equal(ledger.withdrawalsHydrated, false, '失败不得被记成"已回填"');
  assert.equal(ledger.isWithdrawn(TARGET_WITHDRAWN), false, '失败时 isWithdrawn 仍按内存答（同步签名不变：不许抛）');

  // 存储恢复 ⇒ 下一次 hydrate() 重试成功，集合就位。
  state.armed = false;
  await ledger.hydrate();
  assert.equal(ledger.withdrawalsHydrated, true, '重试成功之后才算已回填');
  assert.equal(ledger.isWithdrawn(TARGET_WITHDRAWN), true, '重试成功后集合必须就位');
  assert.equal(ledger.snapshotCounts().withdrawn, 1);
});

test('T6. 回填持续失败 ⇒ flush() 必须拒绝，文案含「回填」（不许当成"没有下架行"放行）', async () => {
  const { pool } = makePool({ armed: true });
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });

  await assert.rejects(
    () => ledger.flush(),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `实际 ${error.code}：${error.message}`);
      assert.ok(error.message.includes('回填'), `flush 的拒绝必须点明"回填"：${error.message}`);
      assert.ok(error.message.includes('结论未落定'), '且必须沿用写面口径的"未落定"，不许被读成已保存');
      return true;
    },
  );
  assert.equal(ledger.withdrawalsHydrated, false, '持续失败时永远不声称已回填');
});
