/**
 * GY-R72 · 在线到期清除的**闭集**与「blocked 原因码不被覆写」（C3）回归用例。
 *
 * 两条互不依赖的断言：
 *
 *   1. **T1 闭集**：`ONLINE_PURGE_MODULES`（时钟驱动真正跑的域）必须与读面推导集合
 *      `ONLINE_EVIDENCE_MODULES` **逐字相同**（8 项：四域 + 识别/语音/OCR/作业），社区域
 *      （`community`）继续排除（F13 是「保留+脱敏」，没有「清空行数」这个事实）。
 *      CLI 必须把**这个** 闭集交给驱动 —— 少了任何一域，该域在受理时失败后就没有任何时钟会重试它。
 *      本文件同时钉住「CLI 不再自带一份四域端口实现」（两份实现是缺陷的成因之一）。
 *
 *   2. **T6 C3**：`refreshOnlineStates()` 的 blocked 分支原先无条件把 `errorCode` 改写成推导出的
 *      码（`STORE_REJECTED`），把受理时更具体的原因（`HANDLER_FAILED` / `POLICY_BLOCKED`）抹掉；
 *      而同函数 pending 分支**有**守卫（`beforeState !== 'completed' && beforeState !== 'blocked'`）。
 *      修法：已是 blocked 且带原因码的行，保留原码。四条子行为都在这里：
 *        (a) blocked + 原码 ⇒ 保留原码；
 *        (b) completed 行 + 推导 blocked ⇒ 照旧覆盖成 `STORE_REJECTED`（行为不变）；
 *        (c) completed 行 + 推导 pending ⇒ 不动（既有守卫）；
 *        (d) blocked 行 + 推导 pending ⇒ 不动（既有守卫）。
 *
 * 真库侧（T1 dry-run 实跑、T2 八域补清、T3 幂等）见 `tests/integration/online-purge-pg.mjs` 组 [10]。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import {
  FAVORITES_DELETION_MODULE,
  ONLINE_EVIDENCE_MODULES,
  RECOGNITIONS_DELETION_MODULE,
  USER_DATA_DELETION_MODULES,
  createUserDataDeletion,
} from '../../services/api/src/privacy/user-data-deletion.ts';
import {
  ONLINE_PURGE_MODULES,
  createOnlinePurgePort,
} from '../../services/api/src/privacy/online-purge-port.ts';
import { scriptedClock } from './favorites-history-fixtures.mjs';

const USER_A = '0193a0f0-0000-4000-8000-00000000a0r72';
const CLI_PATH = new URL('../../tools/purge-expired-online-data.mjs', import.meta.url);
const PORT_PATH = new URL('../../services/api/src/privacy/online-purge-port.ts', import.meta.url);

/** 四个条件域（受理时可能被 blocked，只有时钟能重试它们）。 */
const CONDITIONAL_MODULES = ['recognitions', 'speech', 'ocr', 'jobs'];

function otherStores() {
  const clock = scriptedClock();
  return {
    favoritesStore: createMemoryFavoritesStore({ now: () => clock.ms }),
    historyStore: createMemoryHistoryStore({ now: () => clock.ms }),
    messagesStore: createMemoryMessagesStore({ now: () => clock.ms }),
    conversationsStore: createMemoryConversationStore(),
  };
}

/**
 * 脚本化推导端口：只给指定域 `blocked`（原因码 `STORE_REJECTED`，正是"到期却没证据"的形状），
 * 其余域给 `pending`。⛔ 不触库：C3 只关心账本行的改写规则。
 */
function deriveScript({ blocked = [] } = {}) {
  return async ({ modules }) => ({
    requestId: 'scripted',
    modules: modules.map((module) => (blocked.includes(module)
      ? { module, state: 'blocked', errorCode: 'STORE_REJECTED' }
      : { module, state: 'pending' })),
    overall: blocked.length > 0 ? 'blocked' : 'pending',
    missingModules: modules,
  });
}

/** 受理路径里让识别域必然失败（store 缺按主体清空的原语 ⇒ 处理器抛 ⇒ 协议折叠 blocked）。 */
function deletionWith({ derive } = {}) {
  const input = {
    ...otherStores(),
    recognitionsStore: { kind: 'broken-recognitions' },
  };
  if (derive !== undefined) input.onlineStates = { kind: 'unwired', available: true, derive };
  return createUserDataDeletion(input);
}

function handlerRow(deletion, requestId, module) {
  const row = deletion.receipt(String(requestId)).handlers.find((entry) => entry.module === module);
  assert.ok(row !== undefined, `回执必须含 ${module} 行`);
  return row;
}

// ---------------------------------------------------------------------------
// T1 · 闭集
// ---------------------------------------------------------------------------

test('T1 闭集：时钟驱动的域 = 在线证据闭集（8 项，不含 community）', () => {
  assert.deepEqual(
    [...ONLINE_PURGE_MODULES],
    [...ONLINE_EVIDENCE_MODULES],
    '时钟驱动的域必须与读面推导集合逐字相同：少一域 = 该域失败后没有任何时钟会重试',
  );
  assert.equal(ONLINE_PURGE_MODULES.length, 8, '四域 + 识别/语音/OCR/作业');
  for (const module of [...USER_DATA_DELETION_MODULES, ...CONDITIONAL_MODULES]) {
    assert.ok(ONLINE_PURGE_MODULES.includes(module), `闭集必须含 ${module}`);
  }
  assert.equal(
    ONLINE_PURGE_MODULES.includes('community'),
    false,
    '社区域是「保留+脱敏」，没有「清空行数」事实 ⇒ 不进时钟驱动闭集',
  );
});

test('T1 CLI：把闭集交给驱动，且不再自带一份四域端口实现', () => {
  const source = readFileSync(CLI_PATH, 'utf8');
  assert.ok(
    source.includes('modules: portSet.modules'),
    'CLI 必须把「本轮探测通过的域」交给 drainDueOnlineDeletions',
  );
  assert.ok(
    source.includes('await createOnlinePurgePort(pool)'),
    'CLI 必须用共用的端口装配（同一份实现，避免"传的域"与"端口认得的域"漂移）',
  );
  assert.equal(
    source.includes('createFourDomainPurgePort'),
    false,
    '四域端口实现必须从 CLI 移到 online-purge-port.ts 并扩成闭集，⛔ 不留第二份',
  );
  assert.equal(
    source.includes('USER_DATA_DELETION_MODULES'),
    false,
    'CLI 不得再直接引用四域常量（它就是缺陷的入口）',
  );
  // 运维要能一眼看出"这一轮替哪些域尽到了时间承诺、跳了哪几域、为什么"。
  assert.ok(source.includes('ONLINE_PURGE_MODULES.join'), 'dry-run/真跑都要先打印本轮闭集');
  assert.ok(source.includes('skippedModules'), '跳过的域必须逐条列出来（⛔ 不静默少清）');
});

test('T1 端口：8 域都在映射表里，闭集外的模块一律拒绝（不猜要删什么）', async () => {
  const source = readFileSync(PORT_PATH, 'utf8');
  for (const module of [...USER_DATA_DELETION_MODULES, ...CONDITIONAL_MODULES]) {
    assert.ok(
      source.includes(`    ${module}: () =>`),
      `端口映射表必须注册 ${module}（否则运行期抛"未知的必需模块"）`,
    );
  }
  // 表探测返回"都在" ⇒ 8 域全可用；闭集外的模块名必须在调原语前就被拒。
  const pool = { query: async () => ({ rows: [] }) };
  const set = await createOnlinePurgePort(pool);
  assert.deepEqual([...set.modules], [...ONLINE_PURGE_MODULES], '8 域探测通过 ⇒ 全进 modules');
  assert.deepEqual(set.skippedModules, [], '没有缺表就不该有跳过项');
  await assert.rejects(
    set.purge.purgeModule({ requestId: 'r-1', userId: USER_A, module: 'community' }),
    (error) => error?.code === 'STORE_REJECTED',
    '闭集外的模块必须拒绝（⛔ 不静默返回 0）',
  );
});

test('T1 跳过：某域缺表 ⇒ 只跳过它、原因写清、不抛错（⛔ 不让整轮报错，也不静默少清）', async () => {
  // 假池子：只承认 ocr_* 三张表缺失，其余域"都在"。
  const pool = {
    query: async (_sql, params) => ({
      rows: (Array.isArray(params?.[0]) ? params[0] : [])
        .filter((name) => String(name).startsWith('ocr_'))
        .map((name) => ({ name })),
    }),
  };
  const set = await createOnlinePurgePort(pool);
  assert.equal(set.modules.length, ONLINE_PURGE_MODULES.length - 1, '只少 OCR 一域');
  assert.equal(set.modules.includes('ocr'), false, '缺表的域不得进 modules（否则每轮失败行）');
  assert.deepEqual(
    set.skippedModules.map((entry) => entry.module),
    ['ocr'],
    '跳过的域必须逐条列出',
  );
  const reason = set.skippedModules[0].reason;
  assert.ok(reason.includes('public.ocr_records'), `原因要指名缺哪张表：${reason}`);
  assert.equal(reason.includes('postgres://'), false, '原因不得带连接串');
  // 其余七域照常可清（接口形状不变）。
  assert.equal(typeof set.purge.purgeModule, 'function');
});

test('T1 跳过（授权）：jobs 缺 owner_id 列级 SELECT ⇒ 只跳过 jobs 并点名缺的授权', async () => {
  // 假池子：表都在；权限探测回「表级 DELETE 有、owner_id 列级 SELECT 没有」——
  // 这正是本仓库出厂授权的实测形状（`20-login-roles.sql:980` 的列清单没含 owner_id，
  // 而 `DELETE … WHERE owner_id = $1` 要读该列 ⇒ 真库上必然 42501）。
  const pool = {
    query: async (sql) =>
      sql.includes('has_column_privilege')
        ? { rows: [{ table_delete: true, owner_select: false }] }
        : { rows: [] },
  };
  const set = await createOnlinePurgePort(pool);
  assert.equal(set.modules.includes('jobs'), false, '缺授权的域不得进 modules（否则每轮都是失败行）');
  assert.deepEqual(
    set.skippedModules.map((entry) => entry.module),
    ['jobs'],
    '跳过的域必须逐条列出（⛔ 不静默少清）',
  );
  const reason = set.skippedModules[0].reason;
  assert.ok(reason.includes('owner_id'), `原因要点名缺的列级授权：${reason}`);
  assert.ok(reason.includes('20-login-roles.sql'), `原因要指出该去哪个文件补：${reason}`);

  // 同一份代码在授权补齐后必须照常纳入（⛔ 不是把 jobs 硬编码跳过）。
  const fixed = {
    query: async (sql) =>
      sql.includes('has_column_privilege')
        ? { rows: [{ table_delete: true, owner_select: true }] }
        : { rows: [] },
  };
  const fixedSet = await createOnlinePurgePort(fixed);
  assert.deepEqual([...fixedSet.modules], [...ONLINE_PURGE_MODULES], '授权补齐后 8 域全进 modules');
  assert.deepEqual(fixedSet.skippedModules, [], '授权齐备 ⇒ 无跳过项');
});

test('T1 反控：某域没注入 ⇒ 读面推导不把该域算进闭集（不放宽 requiredModules 过滤）', async () => {
  let asked = null;
  const deletion = createUserDataDeletion({
    ...otherStores(),
    // ⛔ 不注入 recognitions/speech/ocr/jobs：模拟"这个部署只有四域"。
    onlineStates: {
      kind: 'unwired',
      available: true,
      derive: async ({ modules }) => {
        asked = [...modules];
        return {
          requestId: 'reverse',
          modules: modules.map((module) => ({ module, state: 'pending' })),
          overall: 'pending',
          missingModules: [],
        };
      },
    },
  });
  const request = deletion.requestDeletionFor(USER_A);
  const requestId = String(request.id);
  await deletion.executeHandlers(requestId);
  await deletion.refreshOnlineStates(requestId);

  assert.deepEqual(
    asked,
    [...USER_DATA_DELETION_MODULES],
    '推导范围必须仍是「实际注入的域」：把没接入的域算进来只会凭空报 blocked',
  );
  for (const module of CONDITIONAL_MODULES) {
    assert.equal(asked.includes(module), false, `未注入的 ${module} 不得进推导集合`);
  }
  // 更强的钉子：未注入的域连回执行都不该有，更不该被记成 blocked（否则读面凭空报「到期却没清」）。
  const rows = deletion.receipt(requestId).handlers;
  for (const module of CONDITIONAL_MODULES) {
    assert.equal(
      rows.some((row) => row.module === module),
      false,
      `未注入的 ${module} 不得出现在回执里（更不得记 blocked）`,
    );
  }
});

// ---------------------------------------------------------------------------
// T6 · C3：blocked 分支不得覆写更具体的原因码
// ---------------------------------------------------------------------------

test('T6a blocked 行带原因码 ⇒ 刷新保留原码（不得改写成 STORE_REJECTED）', async () => {
  const deletion = deletionWith({ derive: deriveScript({ blocked: [RECOGNITIONS_DELETION_MODULE] }) });
  const request = deletion.requestDeletionFor(USER_A);
  const requestId = String(request.id);
  await deletion.executeHandlers(requestId);

  const before = handlerRow(deletion, requestId, RECOGNITIONS_DELETION_MODULE);
  assert.equal(before.online_state, 'blocked', '缺原语 ⇒ 受理时就 blocked');
  assert.equal(before.error_code, 'HANDLER_FAILED', '受理时更具体的原因是 HANDLER_FAILED');
  // 受理时处理器就抛了 ⇒ 没有任何删除证据（连 `online-blocked:` 段都没有）；段是**读面刷新**补的。
  const beforeEvidence = deletion.evidenceOf(requestId)[RECOGNITIONS_DELETION_MODULE] ?? '';
  assert.equal(
    beforeEvidence.includes('recognitions:online-purged'),
    false,
    `没清就不能有清除证据：${beforeEvidence || '(无证据行)'}`,
  );

  await deletion.refreshOnlineStates(requestId);

  const after = handlerRow(deletion, requestId, RECOGNITIONS_DELETION_MODULE);
  assert.equal(after.online_state, 'blocked', '到期无证据 ⇒ 仍是 blocked');
  assert.equal(
    after.error_code,
    'HANDLER_FAILED',
    'C3：blocked 分支不得把已带原因码的行覆写成 STORE_REJECTED（"存储拒绝"是另一件事）',
  );
  assert.equal(
    after.error_code === 'STORE_REJECTED',
    false,
    '推导出来的 STORE_REJECTED 不得顶掉受理时的事实',
  );
  const afterEvidence = deletion.evidenceOf(requestId)[RECOGNITIONS_DELETION_MODULE] ?? '';
  assert.ok(
    afterEvidence.includes('recognitions:online-blocked:HANDLER_FAILED'),
    `原错因段必须保留（不丢原错误码）：${afterEvidence}`,
  );
  assert.equal(
    afterEvidence.includes('STORE_REJECTED'),
    false,
    `证据串不得出现覆写后的码：${afterEvidence}`,
  );
});

test('T6b 非 blocked 行（completed）推导 blocked ⇒ 照旧覆盖成 STORE_REJECTED', async () => {
  const deletion = deletionWith({ derive: deriveScript({ blocked: [FAVORITES_DELETION_MODULE] }) });
  const request = deletion.requestDeletionFor(USER_A);
  const requestId = String(request.id);
  await deletion.executeHandlers(requestId);

  const before = handlerRow(deletion, requestId, FAVORITES_DELETION_MODULE);
  assert.equal(before.online_state, 'completed', '内存路径正常清空 ⇒ completed');

  await deletion.refreshOnlineStates(requestId);

  const after = handlerRow(deletion, requestId, FAVORITES_DELETION_MODULE);
  assert.equal(after.online_state, 'blocked', '到期且无落库证据 ⇒ blocked（行为不变）');
  assert.equal(after.error_code, 'STORE_REJECTED', '非 blocked 行照旧按推导码覆盖（行为不变）');
});

test('T6c completed 行推导 pending ⇒ 不动（既有守卫）', async () => {
  const deletion = deletionWith({ derive: deriveScript() });
  const request = deletion.requestDeletionFor(USER_A);
  const requestId = String(request.id);
  await deletion.executeHandlers(requestId);

  const before = handlerRow(deletion, requestId, FAVORITES_DELETION_MODULE);
  assert.equal(before.online_state, 'completed');

  await deletion.refreshOnlineStates(requestId);

  const after = handlerRow(deletion, requestId, FAVORITES_DELETION_MODULE);
  assert.equal(after.online_state, 'completed', 'pending 不覆盖 completed（约束 3）');
  assert.equal(after.error_code, null);
});

test('T6d blocked 行推导 pending ⇒ 不动（既有守卫，原因码也不动）', async () => {
  const deletion = deletionWith({ derive: deriveScript() });
  const request = deletion.requestDeletionFor(USER_A);
  const requestId = String(request.id);
  await deletion.executeHandlers(requestId);

  const before = handlerRow(deletion, requestId, RECOGNITIONS_DELETION_MODULE);
  assert.equal(before.online_state, 'blocked');
  assert.equal(before.error_code, 'HANDLER_FAILED');

  await deletion.refreshOnlineStates(requestId);

  const after = handlerRow(deletion, requestId, RECOGNITIONS_DELETION_MODULE);
  assert.equal(after.online_state, 'blocked', 'pending 不覆盖 blocked（约束 3）');
  assert.equal(after.error_code, 'HANDLER_FAILED', '原因码同样不被抹掉');
});
