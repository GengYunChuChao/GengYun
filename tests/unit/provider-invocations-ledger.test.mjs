/**
 * `provider_invocations`（迁移 0050）最小垂直片的用例。
 *
 * 这一片钉三件事，缺一条就等于没做：
 *  1. **DDL 与代码只有一份词表**：迁移 0050 里 `invocation_state` 的闭集 CHECK，与
 *     `services/api/src/privacy/ledger-pg.ts` 的 `INVOCATION_STATES` 逐字一致（多一个/少一个都红）；
 *     表名/唯一键/索引/`job_id` 无外键也在这里钉住，免得日后被「顺手加个 FK」改回去。
 *  2. **什么时候写**：只有**外发真的发生**之后才写一行（成功 ⇒ `sent`；供应商回错 ⇒ `send_failed`）；
 *     零外发路径（非 real 模式、执行前重查拒绝）**零行** —— 写早了会把「没发」洗成「发过」。
 *  3. **写失败怎么处置**：既不许咽成静默（`invocationReadings()` 必须涨、事件必须发），
 *     也不许把已经成功的问答判成失败（`send` 仍然 resolve）。
 *
 * 全部用**假 pool / 替身账本**：本片没有真库（`GY_PG_BIN` 集成用例另有一支），
 * 迁移是否能在真 PG 上跑通**未验证**（见交付报告的未验证清单）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INVOCATION_STATE,
  INVOCATION_STATES,
  createPostgresExportLedger,
} from '../../services/api/src/privacy/ledger-pg.ts';
import { createChatEgress } from '../../services/api/src/privacy/task-egress.ts';
import { CHAT_PROMPT_VERSION, chatModelVersion } from '../../services/api/src/ai/chat-live-adapter.ts';
import { PrivacyError } from '../../packages/privacy/errors.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATION = 'services/api/db/migrations/0050_provider_invocations.sql';
const ROLLBACK = 'services/api/db/migrations/rollback/0050_provider_invocations.down.sql';

function read(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

/** 数据字典第 48 行的那 14 个字段（唯一口径来源，本片不改它，只用它**核对** DDL）。 */
const DICTIONARY_COLUMNS = [
  'id',
  'job_id',
  'attempt',
  'capability',
  'provider_version',
  'model_version',
  'sdk_version',
  'prompt_version',
  'rule_version',
  'external_request_ref_cipher',
  'invocation_state',
  'sent_at',
  'duration_ms',
  'usage',
  'export_id',
];

/** 迁移里 `CHECK (invocation_state IN (…))` 的词表（从 SQL 文本里读，不手抄）。 */
function migrationStates() {
  const sql = read(MIGRATION);
  const matched = /CHECK \(invocation_state IN \(([^)]*)\)\)/.exec(sql);
  assert.ok(matched, '迁移 0050 必须给出 invocation_state 的闭集 CHECK');
  return [...matched[1].matchAll(/'([a-z_]+)'/g)].map((hit) => hit[1]);
}

// ---------------------------------------------------------------------------
// 一、DDL：词表一致 + 两处裁决落实
// ---------------------------------------------------------------------------

test('迁移 0050 的 invocation_state 闭集与代码常量逐字一致（同一份词表，两处落地）', () => {
  assert.deepEqual(migrationStates().sort(), [...INVOCATION_STATES].sort());
  // 三种结局必须都在：已发出 / 发送失败 / 被拦截未发出。
  for (const state of ['sent', 'send_failed', 'blocked']) {
    assert.ok(INVOCATION_STATES.includes(state), `代码常量缺状态：${state}`);
    assert.ok(migrationStates().includes(state), `迁移 CHECK 缺状态：${state}`);
  }
  // 常量本身是冻结的（防止运行期被改写后与 CHECK 漂开）。
  assert.equal(Object.isFrozen(INVOCATION_STATE), true);
  assert.equal(Object.isFrozen(INVOCATION_STATES), true);
});

test('迁移 0050：数据字典的 14 列一列不缺（DDL 是字典的落地，不是另一套口径）', () => {
  const sql = read(MIGRATION);
  for (const column of DICTIONARY_COLUMNS) {
    assert.match(
      sql,
      new RegExp(`^\\s{2}${column} `, 'm'),
      `迁移 0050 的 CREATE TABLE 里缺列：${column}`,
    );
  }
  // 另有 created_at：字典未列，但落库时刻必须有（sent_at 可空，不能顶替）。
  assert.match(sql, /^\s{2}created_at timestamptz NOT NULL DEFAULT now\(\),?$/m);
});

test('迁移 0050：job_id 无外键且允许 NULL（public.jobs 零 INSERT 的直接后果）', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /^ {2}job_id uuid,$/m, 'job_id 必须是不带外键、可空的 uuid 列');
  assert.doesNotMatch(sql, /job_id uuid[^,\n]*REFERENCES/i, 'job_id 不许加外键');
  // 理由必须写在迁移里（不是只写在派单里）。
  assert.match(sql, /public\.jobs/, '迁移注释必须说明为什么本刻不能加 jobs 外键');
  assert.match(sql, /(零 INSERT|没有一行 jobs)/, '迁移注释必须写明「public.jobs 全仓零 INSERT」这一事实');
  // unique 照建：NULL 在唯一索引里互不相等。
  assert.match(sql, /UNIQUE \(job_id, attempt\)/);
  assert.match(sql, /NULL[^。\n]*互不相等/);
});

test('迁移 0050：export_id 挂 exports 且有索引；attempt/duration_ms 非负；usage 是 jsonb 对象', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /export_id uuid NOT NULL REFERENCES public\.exports \(id\)/);
  assert.match(sql, /ON DELETE CASCADE/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS provider_invocations_export_attempt_idx/);
  assert.match(sql, /\(export_id, attempt\)/);
  assert.match(sql, /CHECK \(attempt >= 1\)/);
  assert.match(sql, /CHECK \(duration_ms IS NULL OR duration_ms >= 0\)/);
  assert.match(sql, /CHECK \(usage IS NULL OR jsonb_typeof\(usage\) = 'object'\)/);
});

test('回滚件与正向迁移同名配对，且「有数据就不许删」是硬闸（每行都是一次已发生的外发）', () => {
  const sql = read(ROLLBACK);
  assert.match(sql, /DROP TABLE public\.provider_invocations/);
  assert.doesNotMatch(sql, /DROP TABLE IF EXISTS public\.provider_invocations/);
  assert.match(sql, /PROVIDER_INVOCATIONS_ROLLBACK_BLOCKED/);
  // 回滚件不许顺手删别人的表。
  assert.doesNotMatch(sql, /DROP TABLE public\.exports/);
  assert.doesNotMatch(sql, /DROP TABLE public\.jobs/);
});

// ---------------------------------------------------------------------------
// 二、账本写原语：假 pool（不连真库）
// ---------------------------------------------------------------------------

const EXPORT_ID = '00000000-0000-4000-8f00-0000000000a1';
const JOB_ID = '00000000-0000-4000-8f00-0000000000a2';

let invocationSeq = 0;

/**
 * `provider_invocations` 的假连接池：只模拟本片真正会发的四类 SQL。
 * 其余 SQL 一律抛错（漏模拟就在这里暴露，而不是悄悄返回空行）。
 */
function createInvocationPool({ failInsert = null } = {}) {
  const rows = [];
  const queries = [];
  const client = {
    release() {},
    async query(text, params = []) {
      queries.push({ text, params });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (/SET LOCAL lock_timeout/.test(text)) return { rows: [], rowCount: 0 };
      if (/COALESCE\(MAX\(attempt\)/.test(text)) {
        return { rows: [{ attempt: rows.length + 1 }], rowCount: 1 };
      }
      if (/INSERT INTO public\.provider_invocations/.test(text)) {
        if (failInsert) throw failInsert;
        invocationSeq += 1;
        const row = {
          id: `00000000-0000-4000-8f00-${String(invocationSeq).padStart(12, '0')}`,
          job_id: params[0],
          attempt: params[1],
          capability: params[2],
          provider_version: params[3],
          model_version: params[4],
          sdk_version: params[5],
          prompt_version: params[6],
          rule_version: params[7],
          external_request_ref_cipher: params[8],
          invocation_state: params[9],
          sent_at: params[10],
          duration_ms: params[11],
          usage: params[12] === null ? null : JSON.parse(params[12]),
          export_id: params[13],
          created_at: new Date().toISOString(),
        };
        rows.push(row);
        return { rows: [row], rowCount: 1 };
      }
      throw new Error(`未模拟的 SQL（client）：${text}`);
    },
  };
  const pool = {
    rows,
    queries,
    async connect() {
      return client;
    },
    async query(text, params = []) {
      queries.push({ text, params });
      if (/to_regclass\('public\.export_writebacks'\)/.test(text)) {
        return { rows: [{ wb: 'export_writebacks', upd: true, upd_cancel: true }], rowCount: 1 };
      }
      if (/FROM public\.provider_invocations/.test(text)) {
        const limit = typeof params[1] === 'number' ? params[1] : 50;
        const ordered = [...rows].sort((left, right) => left.attempt - right.attempt).slice(0, limit);
        return { rows: ordered, rowCount: ordered.length };
      }
      throw new Error(`未模拟的 SQL（pool）：${text}`);
    },
  };
  return pool;
}

test('recordInvocation：attempt 由账本派生（同一 export 第 1、2 条），调用方不许自报', async () => {
  const pool = createInvocationPool();
  const ledger = createPostgresExportLedger({ pool });
  const first = await ledger.recordInvocation({
    exportId: EXPORT_ID,
    capability: 'llm',
    invocationState: INVOCATION_STATE.sent,
  });
  const second = await ledger.recordInvocation({
    exportId: EXPORT_ID,
    capability: 'llm',
    invocationState: INVOCATION_STATE.sendFailed,
  });
  assert.equal(first.attempt, 1);
  assert.equal(second.attempt, 2);
  // 派生 SQL 真的发过（不是代码里自增的计数器冒充）。
  assert.ok(pool.queries.some((entry) => /COALESCE\(MAX\(attempt\)/.test(entry.text)));
  // 入参上**没有** attempt 这一列可写：传了也不生效（结构上没有该字段）。
  const attempted = await ledger.recordInvocation({
    exportId: EXPORT_ID,
    capability: 'llm',
    invocationState: INVOCATION_STATE.sent,
    attempt: 99,
  });
  assert.equal(attempted.attempt, 3, 'attempt 必须由账本派生，调用方传的值不生效');
});

test('recordInvocation：非法状态/能力/负耗时在**落库之前**拒绝（零 SQL）', async () => {
  const cases = [
    [{ exportId: 'not-a-uuid', capability: 'llm', invocationState: 'sent' }, 'export_id 非法'],
    [{ exportId: EXPORT_ID, capability: 'LLM!', invocationState: 'sent' }, 'capability 非法'],
    [{ exportId: EXPORT_ID, capability: 'llm', invocationState: 'maybe' }, '不在闭集内'],
    [{ exportId: EXPORT_ID, capability: 'llm', invocationState: 'sent', durationMs: -1 }, 'duration_ms 非法'],
  ];
  for (const [input, hint] of cases) {
    const pool = createInvocationPool();
    const ledger = createPostgresExportLedger({ pool });
    await assert.rejects(
      () => ledger.recordInvocation(input),
      (error) => {
        assert.ok(error instanceof PrivacyError, '必须是契约错误');
        assert.equal(error.code, 'INVALID_REQUEST');
        assert.match(error.message, new RegExp(hint));
        return true;
      },
    );
    assert.deepEqual(pool.queries, [], '校验不通过时一条 SQL 都不许发');
  }
});

test('recordInvocation：usage 只留非负整数键值；全丢光写 NULL（不写 {} 冒充读数）', async () => {
  const pool = createInvocationPool();
  const ledger = createPostgresExportLedger({ pool });
  const kept = await ledger.recordInvocation({
    exportId: EXPORT_ID,
    capability: 'llm',
    invocationState: INVOCATION_STATE.sent,
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, 'bad-key': 3, nested: { a: 1 }, negative: -2, float: 1.5 },
  });
  assert.deepEqual(kept.usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
  const dropped = await ledger.recordInvocation({
    exportId: EXPORT_ID,
    capability: 'llm',
    invocationState: INVOCATION_STATE.sent,
    usage: { 'Bad Key': 1, other: 'text' },
  });
  assert.equal(dropped.usage, null, '全被丢弃时必须写 NULL，⛔ 不写空对象');
});

test('recordInvocation：版本串形状不合 ⇒ INVALID_REQUEST；NULL 放行（⛔ 不填占位串）', async () => {
  const pool = createInvocationPool();
  const ledger = createPostgresExportLedger({ pool });
  await assert.rejects(
    () => ledger.recordInvocation({
      exportId: EXPORT_ID,
      capability: 'llm',
      invocationState: INVOCATION_STATE.sent,
      modelVersion: 'model/带空格 的名字#live-1',
    }),
    (error) => error.code === 'INVALID_REQUEST',
  );
  assert.deepEqual(pool.queries, [], '形状不合必须在落库之前拒');
  const ok = await ledger.recordInvocation({
    exportId: EXPORT_ID,
    capability: 'llm',
    invocationState: INVOCATION_STATE.sent,
    modelVersion: 'model/deepseek-chat#live-1',
    promptVersion: 'prompt/citation-bind/1',
  });
  assert.equal(ok.modelVersion, 'model/deepseek-chat#live-1');
  assert.equal(ok.promptVersion, 'prompt/citation-bind/1');
  assert.equal(ok.providerVersion, null);
  assert.equal(ok.sdkVersion, null);
  assert.equal(ok.ruleVersion, null);
});

test('recordInvocation：默认部署下运行时角色无授权（42501）⇒ 可观测的 PROVIDER_UNAVAILABLE(retryable:false)', async () => {
  const denied = Object.assign(new Error('permission denied for table provider_invocations'), { code: '42501' });
  const pool = createInvocationPool({ failInsert: denied });
  const ledger = createPostgresExportLedger({ pool });
  await assert.rejects(
    () => ledger.recordInvocation({ exportId: EXPORT_ID, capability: 'llm', invocationState: INVOCATION_STATE.sent }),
    (error) => {
      assert.ok(error instanceof PrivacyError);
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.retryable, false, '权限不足不是「稍后重试就好」');
      assert.doesNotMatch(error.message, /provider_invocations/, '不许把驱动原文漏成契约文案');
      return true;
    },
  );
  assert.equal(pool.rows.length, 0);
});

test('listInvocations：按 attempt 升序读取；limit 夹在 1..200', async () => {
  const pool = createInvocationPool();
  const ledger = createPostgresExportLedger({ pool });
  for (const state of [INVOCATION_STATE.sent, INVOCATION_STATE.sendFailed, INVOCATION_STATE.sent]) {
    await ledger.recordInvocation({ exportId: EXPORT_ID, capability: 'llm', invocationState: state });
  }
  const listed = await ledger.listInvocations({ exportId: EXPORT_ID });
  assert.deepEqual(listed.map((row) => row.attempt), [1, 2, 3]);
  await ledger.listInvocations({ exportId: EXPORT_ID, limit: 0 });
  assert.equal(pool.queries.at(-1).params[1], 1, 'limit=0 必须夹到 1');
  await ledger.listInvocations({ exportId: EXPORT_ID, limit: 999 });
  assert.equal(pool.queries.at(-1).params[1], 200, 'limit=999 必须夹到 200');
  await assert.rejects(() => ledger.listInvocations({ exportId: 'nope' }), (error) => error.code === 'INVALID_REQUEST');
});

// ---------------------------------------------------------------------------
// 三、ChatEgress 写点：什么时候写、写什么、写失败怎么办
// ---------------------------------------------------------------------------

const OBJECT_ID = '00000000-0000-4000-8f00-0000000000c1';

/** 账本 + 在途守卫**替身**：只实现 `ChatEgress.send` 会调用的方法，并记录调用顺序。 */
function egressDoubles({ failAt = null, recordFailsWith = null } = {}) {
  const calls = [];
  const invocations = [];
  const ledger = {
    async resolveRecipient(input) {
      calls.push(['resolveRecipient', input]);
      return 'recipient-synthetic-r72';
    },
    async reserve(input) {
      calls.push(['reserve', input]);
      return { id: EXPORT_ID, userId: input.userId, objectRevision: input.objectRevision, jobId: null };
    },
    async markSent(exportId) {
      calls.push(['markSent', exportId]);
      return { id: exportId, userId: 'synthetic-owner', objectRevision: 2, jobId: JOB_ID };
    },
    async markFailed(exportId, payload) {
      calls.push(['markFailed', exportId, payload]);
    },
    async recordInvocation(input) {
      calls.push(['recordInvocation', input]);
      if (recordFailsWith) throw recordFailsWith;
      invocations.push(input);
      return { ...input, attempt: invocations.length };
    },
  };
  const inFlight = {
    async assertExecutable(input) {
      calls.push(['assertExecutable', input]);
      if (failAt === 'assertExecutable') {
        throw new PrivacyError('ACCOUNT_INACTIVE', '账号状态已变更，禁止外发');
      }
    },
    async saveResult(input) {
      calls.push(['saveResult', input]);
    },
  };
  return { ledger, inFlight, calls, invocations };
}

function sendOn(egress, overrides = {}) {
  return egress.send({
    userId: 'synthetic-user',
    authEpoch: 3,
    objectId: OBJECT_ID,
    objectRevision: 2,
    call: async () => ({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }),
    outcomeOf: () => ({ kind: 'answered' }),
    ...overrides,
  });
}

test('外发成功 ⇒ 恰好一行 sent：prompt_version 取 live 常量，usage/duration/sent_at 都是真读数', async () => {
  const doubles = egressDoubles();
  const egress = createChatEgress({ ...doubles, executionMode: 'real' });
  const answer = await sendOn(egress);

  assert.deepEqual(answer.choices, []);
  assert.equal(doubles.invocations.length, 1, '一次外发只许一行');
  const row = doubles.invocations[0];
  assert.equal(row.invocationState, INVOCATION_STATE.sent);
  assert.equal(row.exportId, EXPORT_ID, '必须挂在本次 reserve 出来的 export 上');
  assert.equal(row.jobId, JOB_ID, 'job_id 取 markSent 返回的外发记录（不是调用方自报）');
  assert.equal(row.capability, 'llm');
  assert.equal(row.promptVersion, CHAT_PROMPT_VERSION, 'prompt_version 必须取适配器常量，不许手写');
  assert.equal(row.modelVersion, null, '装配层没给 model ⇒ model_version 留 NULL（⛔ 不填占位串）');
  assert.deepEqual(row.usage, { prompt_tokens: 12, completion_tokens: 4 });
  assert.equal(row.sentAt instanceof Date, true);
  assert.equal(Number.isSafeInteger(row.durationMs) && row.durationMs >= 0, true);

  // 顺序：写记录在 saveResult 之前（正文保存前先把「这一发确实发过」落账）。
  const names = doubles.calls.map((entry) => entry[0]);
  assert.ok(names.indexOf('recordInvocation') < names.indexOf('saveResult'));
  assert.deepEqual(egress.invocationReadings(), { written: 1, failed: 0, lastError: null });
});

test('给了 model ⇒ model_version = chatModelVersion(model)（唯一真源，不复制字面量）', async () => {
  const doubles = egressDoubles();
  const egress = createChatEgress({ ...doubles, executionMode: 'real', model: 'deepseek-chat' });
  await sendOn(egress);
  assert.equal(doubles.invocations[0].modelVersion, chatModelVersion('deepseek-chat'));
  assert.match(doubles.invocations[0].modelVersion, /^model\/deepseek-chat#live-1$/);
});

test('call() 抛错（外发已发生但失败）⇒ 一行 send_failed，原错误照旧抛出', async () => {
  const doubles = egressDoubles();
  const egress = createChatEgress({ ...doubles, executionMode: 'real' });
  const boom = new PrivacyError('PROVIDER_TIMEOUT', '供应商超时', { retryable: true });
  await assert.rejects(
    () => sendOn(egress, { call: async () => { throw boom; } }),
    (error) => error === boom,
  );
  assert.equal(doubles.invocations.length, 1);
  assert.equal(doubles.invocations[0].invocationState, INVOCATION_STATE.sendFailed);
  assert.equal(doubles.invocations[0].usage, null, '失败响应没有可信 usage');
  const markFailed = doubles.calls.find((entry) => entry[0] === 'markFailed');
  assert.equal(markFailed[2].errorCode, 'PROVIDER_TIMEOUT', '失败码来自错误的 code');
  assert.equal(doubles.calls.some((entry) => entry[0] === 'saveResult'), false, '失败不许写回写表');
});

test('供应商以「值」形式回错（不抛）⇒ 一行 send_failed，且按既有语义返回该值', async () => {
  const doubles = egressDoubles();
  const egress = createChatEgress({ ...doubles, executionMode: 'real' });
  const failed = { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
  const outcome = await sendOn(egress, { call: async () => failed });
  assert.equal(outcome, failed);
  assert.equal(doubles.invocations.length, 1);
  assert.equal(doubles.invocations[0].invocationState, INVOCATION_STATE.sendFailed);
  assert.equal(doubles.calls.find((entry) => entry[0] === 'markFailed')[2].errorCode, 'PROVIDER_UNAVAILABLE');
});

test('零外发：非 real 模式 ⇒ 零行、零 reserve（没发就不许有记录）', async () => {
  const doubles = egressDoubles();
  const egress = createChatEgress({ ...doubles, executionMode: 'stub' });
  await assert.rejects(() => sendOn(egress), (error) => error.code === 'PROVIDER_UNAVAILABLE');
  assert.equal(doubles.invocations.length, 0);
  assert.deepEqual(doubles.calls, [], '非 real 模式不许碰账本任何一步');
  assert.deepEqual(egress.invocationReadings(), { written: 0, failed: 0, lastError: null });
});

test('零外发：执行前重查拒绝（账号已变更）⇒ 预留了也零行', async () => {
  const doubles = egressDoubles({ failAt: 'assertExecutable' });
  const egress = createChatEgress({ ...doubles, executionMode: 'real' });
  await assert.rejects(() => sendOn(egress), (error) => error.code === 'ACCOUNT_INACTIVE');
  assert.equal(doubles.invocations.length, 0, '没有外发就不许写行');
  const names = doubles.calls.map((entry) => entry[0]);
  assert.ok(names.includes('reserve'), '这条路径是先预留后拒绝');
  assert.equal(names.includes('markSent'), false);
});

test('写账本失败（成功路径）：问答仍然成功、失败被记录成读数、事件进日志口', async () => {
  const logged = [];
  const writeError = new PrivacyError('PROVIDER_UNAVAILABLE', '外发账本暂不可用（数据库配置/权限不满足）', { retryable: false });
  const doubles = egressDoubles({ recordFailsWith: writeError });
  const egress = createChatEgress({
    ...doubles,
    executionMode: 'real',
    log: (event) => logged.push(event),
  });
  const answer = await sendOn(egress);

  assert.deepEqual(answer.choices, [], '⛔ 记账失败不得把已经成功的问答判成失败');
  assert.deepEqual(egress.invocationReadings(), { written: 0, failed: 1, lastError: 'PROVIDER_UNAVAILABLE' });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, 'provider_invocation_write_failed');
  assert.equal(logged[0].code, 'PROVIDER_UNAVAILABLE');
  assert.equal(logged[0].export_id, EXPORT_ID);
  assert.equal(logged[0].invocation_state, INVOCATION_STATE.sent);
  assert.equal(JSON.stringify(logged[0]).includes('choices'), false, '⛔ 日志只许有安全 token');
  // 正文照旧保留：写账本失败不许连累回写。
  assert.equal(doubles.calls.some((entry) => entry[0] === 'saveResult'), true);
});

test('写账本失败（失败路径）：仍然是供应商的错误往外抛，写错误不许顶替它', async () => {
  const writeError = new PrivacyError('PROVIDER_UNAVAILABLE', '外发账本暂不可用');
  const doubles = egressDoubles({ recordFailsWith: writeError });
  const egress = createChatEgress({ ...doubles, executionMode: 'real', log: () => {} });
  const boom = new PrivacyError('PROVIDER_TIMEOUT', '供应商超时', { retryable: true });
  await assert.rejects(
    () => sendOn(egress, { call: async () => { throw boom; } }),
    (error) => error === boom,
  );
  assert.deepEqual(egress.invocationReadings(), { written: 0, failed: 1, lastError: 'PROVIDER_UNAVAILABLE' });
});

test('默认部署（运行时角色无 42501 授权）端到端：问答成功 + 读数如实记录', async () => {
  const denied = Object.assign(new Error('permission denied for table provider_invocations'), { code: '42501' });
  const pool = createInvocationPool({ failInsert: denied });
  const ledger = createPostgresExportLedger({ pool });
  const logged = [];
  const egress = createChatEgress({
    ledger: {
      ...ledger,
      async resolveRecipient() {
        return 'recipient-synthetic-r72';
      },
      async reserve(input) {
        return { id: EXPORT_ID, userId: input.userId, objectRevision: input.objectRevision, jobId: null };
      },
      async markSent(exportId) {
        return { id: exportId, userId: 'synthetic-owner', objectRevision: 2, jobId: JOB_ID };
      },
      async markFailed() {},
    },
    inFlight: { async assertExecutable() {}, async saveResult() {} },
    executionMode: 'real',
    log: (event) => logged.push(event),
  });
  const answer = await sendOn(egress);
  assert.deepEqual(answer.choices, [], '没有 provider_invocations 授权也不许把问答判失败');
  assert.deepEqual(egress.invocationReadings(), { written: 0, failed: 1, lastError: 'PROVIDER_UNAVAILABLE' });
  assert.equal(logged[0].event, 'provider_invocation_write_failed');
  // 真发过 INSERT（不是没尝试就记失败）。
  assert.ok(pool.queries.some((entry) => /INSERT INTO public\.provider_invocations/.test(entry.text)));
});
