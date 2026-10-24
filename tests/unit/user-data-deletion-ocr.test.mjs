/**
 * #19 延续片（R34 片 3）· OCR 域（三表）接入注销闭集的回归用例（内存实现）。
 *
 * 与识别/语音两域**方向相反**：那两域刻意零表级 DELETE、走 `0034` 的 SECURITY DEFINER 函数；
 * OCR 域是**用户 2026-10-24 批准**的表级 `GRANT DELETE` 例外（唯一一处新增删除面），
 * 因此 `ocr/store-pg.ts` 直接 `DELETE … RETURNING`，行数由 `RETURNING` 如实回报。
 * 这批断言钉住四件事：
 *
 *   1. 闭集：注入才追加（OCR ⇒ +`ocr`；不注入 ⇒ 逐字仍是四域），且注入了就必须有处理器；
 *   2. 正控制：只清本主体的 `ocr_records` / `ocr_jobs` / 台账，他人行原样；
 *      证据串**分列** `:online-purged:` 与 `:idempotency-purged:`，并额外带 `:tables:` 逐表读数；
 *   3. 删序：**先子后父** `ocr_records` → `ocr_jobs` → `ocr_idempotency`（静态读 `store-pg.ts`，
 *      内存与 PG 两条实现同一口径；⛔ 不靠"看起来对"）；
 *   4. 反向控制：store 缺原语 ⇒ 处理器调用即抛 ⇒ 折叠 `blocked` + `HANDLER_FAILED`，
 *      ⛔ 不折成 `completed`、⛔ 不记 0 行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createMemoryOcrStore } from '../../services/api/src/ocr/store.ts';
import {
  OCR_DELETION_MODULE,
  USER_DATA_DELETION_MODULES,
  createUserDataDeletion,
} from '../../services/api/src/privacy/user-data-deletion.ts';

/**
 * 本域自己带一个最小时钟：`tests/unit/favorites-history-fixtures.mjs` 顶部 import 了
 * `@electric-sql/pglite`（真库夹具），本片不需要真库 ⇒ 不引入那份依赖，
 * 让本文件在无 `node_modules` 的树上也能直接 `node --test` 跑。
 */
function scriptedClock() {
  let ms = Date.parse('2026-10-24T03:00:00.000Z');
  return {
    get ms() {
      return ms;
    },
    advance(by = 1000) {
      ms += by;
      return ms;
    },
  };
}

const USER_A = '0193a0f0-0000-4000-8000-00000000c001';
const USER_B = '0193a0f0-0000-4000-8000-00000000d002';
const AT = new Date('2026-10-24T03:00:00.000Z');
const LATER = new Date('2026-10-24T04:00:00.000Z');
/** scope 的形状与 `auth/idempotency.ts` 同源：`<主体>\n<METHOD>\n<路径>`。 */
const ocrScope = (userId) => `${userId}\nPOST\n/v1/ocr/jobs`;

/** 契约四域只需"不缺席"，本片不碰它们的内容。 */
function otherStores() {
  const clock = scriptedClock();
  return {
    favoritesStore: createMemoryFavoritesStore({ now: () => clock.ms }),
    historyStore: createMemoryHistoryStore({ now: () => clock.ms }),
    messagesStore: createMemoryMessagesStore({ now: () => clock.ms }),
    conversationsStore: createMemoryConversationStore(),
  };
}

function jobRow(id, ownerUserId, ocrId) {
  return {
    id,
    revision: 1,
    kind: 'ocr',
    ownerUserId,
    ocrId,
    mediaId: `media-${id}`,
    mediaRevision: 1,
    state: 'queued',
    deadlineAt: LATER,
    createdAt: AT,
    updatedAt: AT,
    errorCode: null,
  };
}

function ocrRow(id, ownerUserId) {
  return {
    id,
    revision: 1,
    ownerUserId,
    mediaId: `media-${id}`,
    mediaRevision: 1,
    rawFields: { registration_number: null, name: null, ingredients: [], dosage_form: null },
    correctedFields: { registration_number: null, name: null, ingredients: [], dosage_form: null },
    verification: {
      match_state: 'unmatched',
      registration: null,
      conflict_fields: [],
      missing_fields: [],
      dose_cards: [],
    },
    modelVersion: 'test-v1',
    createdAt: AT,
    updatedAt: AT,
    deleted: false,
  };
}

/**
 * 播一段 OCR 域数据：
 *   - A：1 个任务 + 1 条记录 + 1 条幂等台账（全部必须被清）；
 *   - B：同形三行（全部必须原样，证明按主体过滤且 scope 前缀没误伤）。
 */
async function seedOcrDomain() {
  const store = createMemoryOcrStore();
  await store.insertJob(jobRow('job-a', USER_A, 'ocr-a'));
  await store.insertJob(jobRow('job-b', USER_B, 'ocr-b'));
  await store.insertOcr(ocrRow('ocr-a', USER_A));
  await store.insertOcr(ocrRow('ocr-b', USER_B));
  for (const [scope, hash] of [[ocrScope(USER_A), 'hash-a'], [ocrScope(USER_B), 'hash-b']]) {
    assert.equal(
      await store.claimIdempotent(scope, hash, {
        requestHash: `req-${hash}`,
        expiresAt: LATER,
        payload: {},
        pending: false,
      }, AT),
      'claimed',
    );
  }
  return store;
}

test('闭集：OCR 注入才追加（五域），不注入 ⇒ 逐字仍是四域', () => {
  const withoutOcr = createUserDataDeletion({ ...otherStores() });
  assert.deepEqual(withoutOcr.requiredModules(), [...USER_DATA_DELETION_MODULES]);
  assert.deepEqual(withoutOcr.requiredModules(), ['favorites', 'history', 'messages', 'conversations']);

  const withOcr = createUserDataDeletion({ ...otherStores(), ocrStore: createMemoryOcrStore() });
  assert.deepEqual(withOcr.requiredModules(), [...USER_DATA_DELETION_MODULES, OCR_DELETION_MODULE]);
  assert.equal(OCR_DELETION_MODULE, 'ocr');
  assert.deepEqual(withOcr.coordinator.missingRegistrations(), [], '注入了 store 就必须有处理器（否则受理即拒）');
});

test('正控制：只清本主体的两条正文表 + 台账，他人行原样；证据按表分列', async () => {
  const ocr = await seedOcrDomain();
  const deletion = createUserDataDeletion({ ...otherStores(), ocrStore: ocr });

  const request = deletion.requestDeletionFor(USER_A);
  await deletion.executeHandlers(String(request.id));

  // 1) A 的两条正文表行都没了（真删除，不是标记 deleted=true）。
  assert.equal(await ocr.getJob('job-a'), null, 'A 的 OCR 任务必须物理删除');
  assert.equal(await ocr.getOcr('ocr-a'), null, 'A 的 OCR 记录必须物理删除');
  // 2) B 不受影响。
  const jobB = await ocr.getJob('job-b');
  assert.ok(jobB !== null, 'B 的 OCR 任务不得被 A 的注销带走');
  assert.equal(jobB.ownerUserId, USER_B);
  const ocrB = await ocr.getOcr('ocr-b');
  assert.ok(ocrB !== null, 'B 的 OCR 记录不得被带走');
  assert.equal(ocrB.ownerUserId, USER_B);
  // 3) 台账按主体前缀清：A 的同键再占位必须 `claimed`，B 必须 `exists`。
  assert.equal(
    await ocr.claimIdempotent(ocrScope(USER_A), 'hash-a', {
      requestHash: 'req-again',
      expiresAt: LATER,
      payload: {},
      pending: false,
    }, AT),
    'claimed',
    'A 的台账行必须被清（否则重建同键会读到旧回执）',
  );
  assert.equal(
    await ocr.claimIdempotent(ocrScope(USER_B), 'hash-b', {
      requestHash: 'req-again-b',
      expiresAt: LATER,
      payload: {},
      pending: false,
    }, AT),
    'exists',
    'B 的台账行不得被 A 的注销清掉',
  );

  // 4) 证据串：正文行数与台账行数**分列**，另带逐表读数（键序 = 删序）。
  const evidence = deletion.evidenceOf(String(request.id))[OCR_DELETION_MODULE] ?? '';
  assert.ok(evidence.includes('ocr:online-purged:2'), `OCR 正文 = 1 记录 + 1 任务 = 2 行：${evidence}`);
  assert.ok(evidence.includes('ocr:idempotency-purged:1'), `OCR 台账 = 1 行（A 那条）：${evidence}`);
  assert.ok(
    evidence.includes('ocr:tables:ocr_records=1,ocr_jobs=1'),
    `逐表读数必须按删序（先子后父）给出：${evidence}`,
  );
  assert.equal(evidence.includes('ocr:blocked'), false, `正常路径不得 blocked：${evidence}`);

  // 5) 回执：在线态 completed；备份态如实 pending（备份副本只覆盖四域，本片未接线）。
  const row = deletion.receipt(String(request.id)).handlers
    .find((entry) => entry.module === OCR_DELETION_MODULE);
  assert.ok(row !== undefined, '回执必须含 ocr 行');
  assert.equal(row.online_state, 'completed', '正文与台账都清了 ⇒ completed');
  assert.equal(row.error_code, null, 'completed 时不得带阻断码');
  assert.equal(row.backup_state, 'pending', '备份副本未接线 ⇒ 如实 pending，⛔ 不谎称完成');

  // 6) 审计读数与证据同口径。
  const audit = deletion.audit().find((entry) => entry.module === OCR_DELETION_MODULE);
  assert.equal(audit.onlineRemoved, 2, '审计的 onlineRemoved = 两表行数之和');
});

test('删序：先子后父（ocr_records → ocr_jobs → ocr_idempotency），且行数由 RETURNING 取真实值', () => {
  // 内存实现：tableCounts 的键插入顺序就是删除顺序。
  const store = createMemoryOcrStore();
  assert.equal(typeof store.purgeOwnerData, 'function', '内存实现必须提供按主体清空原语');
  const source = readFileSync(new URL('../../services/api/src/ocr/store.ts', import.meta.url), 'utf8');
  const memoryBody = source.slice(source.indexOf('const purgeOwnerData = async (ownerId: string)'));
  const memoryWindow = memoryBody.slice(0, 1600);
  assert.ok(
    memoryWindow.indexOf('ocrRows') < memoryWindow.indexOf('jobs'),
    '内存实现必须先去重记录表（ocr_records）再删任务表（ocr_jobs）',
  );

  // PG 实现：静态读删除语句的先后，别靠"看起来对"。
  const pgSource = readFileSync(new URL('../../services/api/src/ocr/store-pg.ts', import.meta.url), 'utf8');
  const pgStart = pgSource.indexOf('async function purgeOwnerRows');
  assert.ok(pgStart > 0, 'store-pg.ts 必须有 purgeOwnerRows');
  const pgWindow = pgSource.slice(pgStart, pgStart + 1600);
  const idxRecords = pgWindow.indexOf('DELETE FROM public.ocr_records WHERE owner_user_id = $1::uuid RETURNING id');
  const idxJobs = pgWindow.indexOf('DELETE FROM public.ocr_jobs WHERE owner_user_id = $1::uuid RETURNING id');
  const idxLedger = pgWindow.indexOf('DELETE FROM public.ocr_idempotency');
  assert.ok(idxRecords > 0, '必须先删 ocr_records');
  assert.ok(idxRecords < idxJobs, 'ocr_records 必须排在 ocr_jobs 之前（先子后父）');
  assert.ok(idxJobs < idxLedger, '两张正文表必须排在台账之前');
  assert.equal(pgWindow.includes('count(*)'), false, '⛔ 不许用 count(*) 冒充删除行数');
  assert.equal(
    (pgWindow.match(/RETURNING id/g) ?? []).length,
    2,
    '两张正文表都必须用 RETURNING 取真实删除行数',
  );
  assert.equal(/purge_owner_ocr/.test(pgSource), false, '本域走表级 DELETE（用户批准的例外），不是 SECURITY DEFINER 函数');
});

test('反向控制：store 缺按主体清空原语 ⇒ 处理器调用即抛、折叠 blocked（⛔ 不静默算完成）', async () => {
  const deletion = createUserDataDeletion({
    ...otherStores(),
    // 只有读路径、没有任何清空方法：模拟"表接了但原语忘了实现"的退化。
    ocrStore: { kind: 'broken-ocr' },
  });
  const request = deletion.requestDeletionFor(USER_A);
  await deletion.executeHandlers(String(request.id));
  const row = deletion.receipt(String(request.id)).handlers
    .find((entry) => entry.module === OCR_DELETION_MODULE);
  assert.equal(row.online_state, 'blocked', '缺原语 ⇒ blocked（不是 completed，也不是"跳过"）');
  assert.equal(row.error_code, 'HANDLER_FAILED', '原因码由协议折叠为 HANDLER_FAILED');
  const evidence = deletion.evidenceOf(String(request.id))[OCR_DELETION_MODULE] ?? '';
  assert.equal(evidence.includes('ocr:online-purged'), false, `没清就不能有清除证据：${evidence || '(无证据行)'}`);
  assert.equal(evidence.includes('ocr:tables:'), false, `没清就不能有逐表读数：${evidence || '(无证据行)'}`);
});
