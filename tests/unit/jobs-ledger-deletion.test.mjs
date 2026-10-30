/**
 * GY-R71 补片 · 统一作业台账 `public.jobs` 接进**注销闭集**（监工 B 档实质阻塞的正面处置）。
 *
 * ## 这条用例在守什么
 * `services/api/src/jobs/ledger.ts` 给 `public.jobs` 写进去的列里，`owner_id` / `target_id`
 * （媒体或轮次）/ `entity_revision` / `result_ref`（产出 id）/ `auth_epoch` **全是私有作业关联**。
 * 源域清理（识别 / 语音 / OCR / 会话）删的是域内表，台账行不在其中 ⇒ 若没有 `jobs` 模块，
 * 注销之后「谁做过哪些作业、作用于哪个媒体、产出是哪个 id」仍留在库里，而回执与证据看不见它。
 * 本文件把「台账行真的被删掉」变成可执行断言，并给出**负控制**：
 *
 *   1. 正控制：注入 `jobsStore` ⇒ 闭集含 `jobs`；注销后该主体的台账行**归零**，
 *      别人的行一行不动，证据串带 `jobs:online-purged:<真实行数>`；
 *   2. 负控制（同文件内）：把原语换成"报告 0 行但不删"的替身 ⇒ 行**仍在**，
 *      证明上面那条断言对「删没删」敏感（不是被 `0 行` 的读数喂饱的）；
 *   3. 边界：空主体 / 空白主体**不调原语**且调用即抛（⛔ 绝不退化成"删全部"）；
 *   4. 行数不可读（`rowCount` 缺失且没有 `RETURNING` 行）⇒ 抛错，⛔ 不把「不知道」报成 0。
 *
 * ## 诚实边界（本文件**没有**证明什么）
 * - 这里跑的是**假池**（内存里的行数组 + 真 SQL 形状断言），**不是真库**：它证明接线与语义，
 *   不证明 PostgreSQL 的权限面（`GRANT DELETE ON public.jobs` 与 90-assert 的探针属部署面）。
 *   真库臂在 `tests/integration/jobs-ledger-pg.mjs` 的同名小节（需要 `GY_PG_DSN`，
 *   起不了库时该臂如实 skip，不当成通过）。
 * - 本文件不覆盖「台账行与源域行同一事务提交」这件事（那是写入侧，见 `tests/unit/jobs-ledger-mapping.test.mjs`
 *   与集成臂）；删除侧按 `owner_id` 一刀删完，与各域处理器同属一个 requestId、但不是同一个数据库事务。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import {
  JOB_LEDGER_PURGE_SQL,
  purgeJobLedgerByOwner,
} from '../../services/api/src/jobs/ledger.ts';
import {
  JOBS_DELETION_MODULE,
  createUserDataDeletion,
} from '../../services/api/src/privacy/user-data-deletion.ts';

const USER_A = '0193a0f0-0000-4000-8000-00000000a001';
const USER_B = '0193a0f0-0000-4000-8000-00000000b002';
const AT = Date.parse('2026-10-30T03:00:00.000Z');

/** 四域替身只需要"不缺席"，内容不是本用的对象。 */
function otherStores() {
  return {
    favoritesStore: createMemoryFavoritesStore({ now: () => AT }),
    historyStore: createMemoryHistoryStore({ now: () => AT }),
    messagesStore: createMemoryMessagesStore({ now: () => AT }),
    conversationsStore: createMemoryConversationStore(),
  };
}

/**
 * 假池：内存行数组 + **真 SQL 形状**。它按 `owner_id` 真删（不是返回假读数），
 * 因此「删了几行」与「还剩几行」是同一个事实的两次读。
 */
function fakeLedger(rows) {
  const state = rows.map((row) => ({ ...row }));
  const queries = [];
  const runner = {
    async query(text, values) {
      queries.push({ text, values });
      if (text !== JOB_LEDGER_PURGE_SQL) throw new Error(`意外的 SQL：${text}`);
      const before = state.length;
      for (let index = state.length - 1; index >= 0; index -= 1) {
        if (state[index].ownerId === values[0]) state.splice(index, 1);
      }
      return { rows: [], rowCount: before - state.length };
    },
  };
  return { state, queries, runner };
}

/** 四条私有作业关联（四个源各一条）：owner A 三条、owner B 一条。 */
function ledgerRows() {
  return [
    { id: 'job-ocr-a', ownerId: USER_A, kind: 'ocr', targetId: 'media-a1', resultRef: 'ocr-a1' },
    { id: 'job-rec-a', ownerId: USER_A, kind: 'recognition', targetId: 'media-a2', resultRef: 'rec-a2' },
    { id: 'job-answer-a', ownerId: USER_A, kind: 'answer', targetId: 'turn-a3', resultRef: 'answer-a3' },
    { id: 'job-speech-b', ownerId: USER_B, kind: 'transcription', targetId: 'media-b1', resultRef: 'tr-b1' },
  ];
}

test('正控制：注销后该主体的台账行归零、别人的行一行不动、证据带真实行数', async () => {
  const { state, queries, runner } = fakeLedger(ledgerRows());
  const deletion = createUserDataDeletion({
    ...otherStores(),
    jobsStore: {
      async deleteAllByOwner(ownerId) {
        return purgeJobLedgerByOwner(runner, ownerId);
      },
      async purgeOwnerData(ownerId) {
        return { records: await purgeJobLedgerByOwner(runner, ownerId), idempotency: 0 };
      },
    },
  });

  assert.ok(deletion.requiredModules().includes(JOBS_DELETION_MODULE),
    '注入 jobsStore ⇒ 生效闭集必须含 jobs（否则协调器根本不会驱动它）');

  const request = deletion.requestDeletionFor(USER_A);
  const receipt = await deletion.executeHandlers(String(request.id));

  // ① 该主体的台账行归零（这就是监工判词要求的那条事实）。
  assert.deepEqual(
    state.filter((row) => row.ownerId === USER_A),
    [],
    '注销后该主体在 public.jobs 里必须一行不剩',
  );
  // ② 别人的行不动（按 owner 收窄，⛔ 不是"删全部"）。
  assert.deepEqual(state.map((row) => row.id), ['job-speech-b'], '他人主体的台账行不得被碰到');
  // ③ 行数是**真实**读数：A 有 3 行 ⇒ 证据写 3，不是写死常量。
  const evidence = deletion.evidenceOf(String(request.id))[JOBS_DELETION_MODULE] ?? '';
  assert.ok(evidence.includes('jobs:online-purged:3'), `证据串必须带真实删除行数：${evidence}`);
  // ④ 只发了一条 DELETE，且带的是该主体（不是空参数）。
  assert.equal(queries.length, 1, `只应有一次删除：${JSON.stringify(queries)}`);
  assert.deepEqual(queries[0].values, [USER_A], 'DELETE 的绑定值必须是该主体');
  // 回执整体态：备份侧未接线 ⇒ 不可能是 completed；但 `jobs` 这一行必须真的在证据里。
  assert.notEqual(receipt['state'], 'completed', `备份未接线时不得报 completed：${JSON.stringify(receipt)}`);

  // ⑤ 幂等：同一主体再清一次是 0 行，不报错（注销重放/重试的既有口径）。
  assert.equal(await purgeJobLedgerByOwner(runner, USER_A), 0, '重复清理必须是 0 行且不抛');
});

test('负控制：把原语换成"报告 0 行但不删"的替身 ⇒ 台账行仍在（上面的断言因此对"删没删"敏感）', async () => {
  const { state, queries } = fakeLedger(ledgerRows());
  const lyingStore = {
    async deleteAllByOwner() {
      return 0;
    },
    async purgeOwnerData() {
      return { records: 0, idempotency: 0 };
    },
  };
  const deletion = createUserDataDeletion({ ...otherStores(), jobsStore: lyingStore });
  const request = deletion.requestDeletionFor(USER_A);
  await deletion.executeHandlers(String(request.id));

  assert.equal(queries.length, 0, '负控制里根本不该有 DELETE 发出');
  assert.deepEqual(
    state.filter((row) => row.ownerId === USER_A).map((row) => row.id),
    ['job-ocr-a', 'job-rec-a', 'job-answer-a'],
    '替身不删 ⇒ 三条私有作业关联仍在库里：这正是正控制要否掉的状态',
  );
  const evidence = deletion.evidenceOf(String(request.id))[JOBS_DELETION_MODULE] ?? '';
  assert.ok(evidence.includes('jobs:online-purged:0'),
    `负控制的证据是 0 —— 所以"证据里有 online-purged"本身不能当删除的证明，行数必须对上真实状态：${evidence}`);
});

test('边界：空主体 / 空白主体调用即抛，且一条 SQL 都不发（⛔ 不退化成删全部）', async () => {
  const { state, queries, runner } = fakeLedger(ledgerRows());
  for (const bad of ['', '   ', '\t']) {
    await assert.rejects(() => purgeJobLedgerByOwner(runner, bad), /拒绝清空全部作业行/, `主体 ${JSON.stringify(bad)} 必须被拒`);
  }
  assert.equal(queries.length, 0, '空主体绝不许把 DELETE 发出去');
  assert.equal(state.length, 4, '库里的行一行不动');
});

test('行数不可读（既没有 rowCount 也没有 RETURNING 行）⇒ 抛错，⛔ 不把「不知道」报成 0', async () => {
  const blind = { async query() { return { rows: [] }; } };
  await assert.rejects(
    () => purgeJobLedgerByOwner(blind, USER_A),
    /拿不到真实删除行数/,
    '行数不可读必须抛（协议会折叠成 blocked），不许静默返回 0',
  );
});

test('端口抛错时该模块如实 blocked（⛔ 不折成 completed，也不折成 0 行）', async () => {
  const failing = {
    async deleteAllByOwner() {
      throw new Error('42501 permission denied for table jobs');
    },
    async purgeOwnerData() {
      const error = new Error('42501 permission denied for table jobs');
      error.code = 'STORE_UNREACHABLE';
      throw error;
    },
  };
  const deletion = createUserDataDeletion({ ...otherStores(), jobsStore: failing });
  const request = deletion.requestDeletionFor(USER_A);
  const receipt = await deletion.executeHandlers(String(request.id));
  assert.equal(receipt['state'], 'blocked', `缺权/连接失败必须 blocked：${JSON.stringify(receipt)}`);
  assert.equal(deletion.completionStatus(String(request.id)).state, 'blocked',
    '整体完成判定也必须是 blocked（⛔ 不是 completed、也不是 pending）');
  const evidence = deletion.evidenceOf(String(request.id))[JOBS_DELETION_MODULE] ?? '';
  assert.equal(evidence, '', '失败时不得留下任何「已清 N 行」形状的证据串（⛔ 不留假证据）');
});
