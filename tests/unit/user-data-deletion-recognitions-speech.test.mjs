/**
 * #19 延续片 · 识别域（四表）与语音域（三表）接入注销闭集的回归用例（内存实现）。
 *
 * 为什么需要它：这两个域**原先没有按主体清空的任何原语**（`recognitions/store*.ts`、
 * `speech/store*.ts` 里 `deleteAllByOwner`/`purgeOwnerData` 零命中），因此它们只能被登记成
 * 「DECLARED_UNREGISTERED」。本片把原语补到存储层（先有原语、再进闭集，顺序不能反），
 * 于是缺口的形态从「表里的表没有处理器」变成「处理器真的清得干净」—— 后者必须被断言：
 *
 *   1. 闭集：注入才追加（识别 ⇒ +`recognitions`；语音 ⇒ +`speech`；都不注入 ⇒ 逐字仍是四域）；
 *   2. 正控制：清理**只**动本主体的行（任务/记录/人工选择/台账），他人行原样；
 *   3. 台账：幂等 scope 按**主体前缀**清（`<主体>\n`，⛔ 不是 `\u0000` 分隔符），
 *      证据串分列 `:online-purged:` 与 `:idempotency-purged:`，⛔ 不合并成一个数；
 *   4. 回执：两域在线态 `completed`、备份态 `pending`（备份副本只覆盖四域，如实未接线）；
 *   5. 反向控制：store 缺原语 ⇒ 处理器调用即抛 ⇒ 折叠 `blocked`，⛔ 不静默算完成。
 *
 * 真库侧的同一口径见 `tests/integration/recognitions-speech-purge-pg.mjs`（PG 17 临时集群）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createMemorySpeechStore } from '../../services/api/src/speech/store.ts';
import {
  RECOGNITIONS_DELETION_MODULE,
  SPEECH_DELETION_MODULE,
  USER_DATA_DELETION_MODULES,
  createUserDataDeletion,
} from '../../services/api/src/privacy/user-data-deletion.ts';
import { scriptedClock } from './favorites-history-fixtures.mjs';

const USER_A = '0193a0f0-0000-4000-8000-00000000a001';
const USER_B = '0193a0f0-0000-4000-8000-00000000b002';
const AT = new Date('2026-10-23T03:00:00.000Z');
const LATER = new Date('2026-10-23T04:00:00.000Z');
/** scope 的形状与 `auth/idempotency.ts` 同源：`<主体>\n<METHOD>\n<路径>`。 */
const recognitionScope = (userId) => `${userId}\nPOST\n/v1/recognitions`;
const speechScope = (userId) => `${userId}\nPOST\n/v1/speech/transcriptions`;

/** 四域只需"不缺席"，本片不碰它们的内容。 */
function otherStores() {
  const clock = scriptedClock();
  return {
    favoritesStore: createMemoryFavoritesStore({ now: () => clock.ms }),
    historyStore: createMemoryHistoryStore({ now: () => clock.ms }),
    messagesStore: createMemoryMessagesStore({ now: () => clock.ms }),
    conversationsStore: createMemoryConversationStore(),
  };
}

function jobRow(id, ownerUserId, recognitionId) {
  return {
    id,
    revision: 1,
    kind: 'recognition',
    ownerUserId,
    recognitionId,
    mediaId: `media-${id}`,
    mediaRevision: 1,
    state: 'queued',
    deadlineAt: LATER,
    createdAt: AT,
    updatedAt: AT,
    errorCode: null,
  };
}

function recognitionRow(id, ownerUserId) {
  return {
    id,
    revision: 1,
    ownerUserId,
    mediaId: `media-${id}`,
    mediaRevision: 1,
    candidates: [],
    uncertaintyReasons: [],
    selectedSpeciesId: null,
    modelVersion: 'test-v1',
    createdAt: AT,
    updatedAt: AT,
    deleted: false,
  };
}

function selectionRecord(id, recognitionId, ownerUserId) {
  return {
    id,
    revision: 1,
    recognitionId,
    ownerUserId,
    speciesId: 'species-rice-blast',
    provenance: 'human',
    decidedAt: AT,
    linkage: { items: [], excluded: [], per_item: [] },
  };
}

function speechJobRow(id, ownerUserId, transcriptionId) {
  return {
    id,
    revision: 1,
    kind: 'transcription',
    ownerUserId,
    transcriptionId,
    mediaId: `media-${id}`,
    mediaRevision: 1,
    state: 'queued',
    deadlineAt: LATER,
    createdAt: AT,
    updatedAt: AT,
    errorCode: null,
  };
}

function transcriptionRow(id, ownerUserId) {
  return {
    id,
    revision: 1,
    ownerUserId,
    mediaId: `media-${id}`,
    mediaRevision: 1,
    rawText: '这块田的稻叶上有褐斑，想确认是不是稻瘟病。',
    uncertainSpans: [],
    confirmedText: null,
    confirmedAt: null,
    modelVersion: 'test-v1',
    createdAt: AT,
    updatedAt: AT,
    deleted: false,
  };
}

/**
 * 播一段两域数据：
 *   - A：1 个识别任务 + 1 条识别记录 + 1 条人工选择（挂在记录下）、1 个语音任务 + 1 条转写；
 *   - A/B 各有一条幂等台账行（A 的必须被清、B 的必须留下）；
 *   - B：1 个识别任务 + 1 条识别记录 + 1 个语音任务 + 1 条转写（全部必须原样）。
 */
async function seedBothDomains() {
  const recognitions = createMemoryRecognitionStore();
  const speech = createMemorySpeechStore();

  await recognitions.insertJob(jobRow('job-a', USER_A, 'rec-a'));
  await recognitions.insertJob(jobRow('job-b', USER_B, 'rec-b'));
  await recognitions.insertRecognition(recognitionRow('rec-a', USER_A));
  await recognitions.insertRecognition(recognitionRow('rec-b', USER_B));
  await recognitions.commitSelection(
    'rec-a',
    1,
    (row) => ({ ...row, revision: row.revision + 1, selectedSpeciesId: 'species-rice-blast' }),
    selectionRecord('sel-a', 'rec-a', USER_A),
  );
  assert.equal(await recognitions.claimIdempotent(recognitionScope(USER_A), 'hash-a', {
    requestHash: 'req-a',
    expiresAt: LATER,
    now: AT,
  }).then((result) => result.status), 'claimed');
  assert.equal(await recognitions.claimIdempotent(recognitionScope(USER_B), 'hash-b', {
    requestHash: 'req-b',
    expiresAt: LATER,
    now: AT,
  }).then((result) => result.status), 'claimed');

  await speech.insertJob(speechJobRow('sjob-a', USER_A, 'tr-a'));
  await speech.insertJob(speechJobRow('sjob-b', USER_B, 'tr-b'));
  await speech.insertTranscription(transcriptionRow('tr-a', USER_A));
  await speech.insertTranscription(transcriptionRow('tr-b', USER_B));
  assert.equal(
    await speech.claimIdempotent(speechScope(USER_A), 'shash-a', {
      requestHash: 'sreq-a',
      expiresAt: LATER,
      payload: {},
      pending: true,
    }, AT),
    'claimed',
  );
  assert.equal(
    await speech.claimIdempotent(speechScope(USER_B), 'shash-b', {
      requestHash: 'sreq-b',
      expiresAt: LATER,
      payload: {},
      pending: true,
    }, AT),
    'claimed',
  );
  return { recognitions, speech };
}

test('闭集：识别/语音各自注入才追加（六域/七域），都不注入 ⇒ 逐字仍是四域', () => {
  const base = otherStores();
  const withoutNewDomains = createUserDataDeletion({ ...base });
  assert.deepEqual(withoutNewDomains.requiredModules(), [...USER_DATA_DELETION_MODULES]);
  assert.deepEqual(withoutNewDomains.requiredModules(), ['favorites', 'history', 'messages', 'conversations']);

  const withRecognitions = createUserDataDeletion({
    ...base,
    recognitionsStore: createMemoryRecognitionStore(),
  });
  assert.deepEqual(
    withRecognitions.requiredModules(),
    [...USER_DATA_DELETION_MODULES, RECOGNITIONS_DELETION_MODULE],
  );
  assert.equal(RECOGNITIONS_DELETION_MODULE, 'recognitions');

  const withBoth = createUserDataDeletion({
    ...base,
    recognitionsStore: createMemoryRecognitionStore(),
    speechStore: createMemorySpeechStore(),
  });
  assert.deepEqual(
    withBoth.requiredModules(),
    [...USER_DATA_DELETION_MODULES, RECOGNITIONS_DELETION_MODULE, SPEECH_DELETION_MODULE],
  );
  assert.equal(SPEECH_DELETION_MODULE, 'speech');
  assert.deepEqual(withBoth.coordinator.missingRegistrations(), [], '注入了 store 就必须有处理器（否则受理即拒）');
});

test('正控制：只清本主体的任务/记录/人工选择/台账，他人行原样；证据按表分列', async () => {
  const { recognitions, speech } = await seedBothDomains();
  const deletion = createUserDataDeletion({
    ...otherStores(),
    recognitionsStore: recognitions,
    speechStore: speech,
  });

  const request = deletion.requestDeletionFor(USER_A);
  await deletion.executeHandlers(String(request.id));

  // 1) 识别域：A 的任务/记录/选择全空（选择行随其父记录一起清）。
  assert.equal(await recognitions.getJob('job-a'), null, 'A 的识别任务必须物理删除');
  assert.equal(await recognitions.getRecognition('rec-a'), null, 'A 的识别记录必须物理删除');
  assert.deepEqual(await recognitions.listSelections('rec-a', USER_A), [], 'A 的人工选择必须随父记录清空');
  // 2) 语音域：A 的任务/转写全空（转写原文是最敏感的一类个人数据，不留副本）。
  assert.equal(await speech.getJob('sjob-a'), null, 'A 的语音任务必须物理删除');
  assert.equal(await speech.getTranscription('tr-a'), null, 'A 的转写记录必须物理删除');

  // 3) 他人不受影响。
  const jobB = await recognitions.getJob('job-b');
  assert.ok(jobB !== null, 'B 的识别任务不得被 A 的注销带走');
  assert.equal(jobB.ownerUserId, USER_B);
  assert.ok((await recognitions.getRecognition('rec-b')) !== null, 'B 的识别记录不得被带走');
  assert.ok((await speech.getJob('sjob-b')) !== null, 'B 的语音任务不得被带走');
  const transcriptionB = await speech.getTranscription('tr-b');
  assert.ok(transcriptionB !== null, 'B 的转写不得被带走');
  assert.equal(transcriptionB.ownerUserId, USER_B);

  // 4) 台账按主体前缀清：A 的同键再占位必须是 `claimed`（行确实没了）；
  //    B 的同键再占位必须**不是** `claimed`（行还在，证明前缀匹配没有误伤他人）。
  assert.equal(
    await recognitions.claimIdempotent(recognitionScope(USER_A), 'hash-a', {
      requestHash: 'req-a-again',
      expiresAt: LATER,
      now: AT,
    }).then((result) => result.status),
    'claimed',
    'A 的识别台账行必须被清（否则重建同键会读到别人的回执）',
  );
  assert.notEqual(
    await recognitions.claimIdempotent(recognitionScope(USER_B), 'hash-b', {
      requestHash: 'req-b-again',
      expiresAt: LATER,
      now: AT,
    }).then((result) => result.status),
    'claimed',
    'B 的台账行不得被 A 的注销清掉',
  );
  assert.equal(
    await speech.claimIdempotent(speechScope(USER_A), 'shash-a', {
      requestHash: 'sreq-a-again',
      expiresAt: LATER,
      payload: {},
      pending: true,
    }, AT),
    'claimed',
    'A 的语音台账行必须被清',
  );
  assert.equal(
    await speech.claimIdempotent(speechScope(USER_B), 'shash-b', {
      requestHash: 'sreq-b-again',
      expiresAt: LATER,
      payload: {},
      pending: true,
    }, AT),
    'exists',
    'B 的语音台账行不得被清',
  );

  // 5) 证据串：正文行数与台账行数**分列**（⛔ 不合并成一个数）。
  const evidence = deletion.evidenceOf(String(request.id));
  const recognitionEvidence = evidence[RECOGNITIONS_DELETION_MODULE];
  assert.ok(
    recognitionEvidence.includes('recognitions:online-purged:3'),
    `识别域正文 = 1 任务 + 1 记录 + 1 选择 = 3 行：${recognitionEvidence}`,
  );
  assert.ok(
    recognitionEvidence.includes('recognitions:idempotency-purged:1'),
    `识别域台账 = 1 行（A 那条）：${recognitionEvidence}`,
  );
  assert.equal(recognitionEvidence.includes('recognitions:blocked'), false, `正常路径不得 blocked：${recognitionEvidence}`);
  const speechEvidence = evidence[SPEECH_DELETION_MODULE];
  assert.ok(speechEvidence.includes('speech:online-purged:2'), `语音域正文 = 1 任务 + 1 转写 = 2 行：${speechEvidence}`);
  assert.ok(speechEvidence.includes('speech:idempotency-purged:1'), `语音域台账 = 1 行：${speechEvidence}`);

  // 6) 回执：两域在线态 completed；备份态如实 pending（备份副本只覆盖四域，本片未接线）。
  const receipt = deletion.receipt(String(request.id));
  for (const module of [RECOGNITIONS_DELETION_MODULE, SPEECH_DELETION_MODULE]) {
    const row = receipt.handlers.find((entry) => entry.module === module);
    assert.ok(row !== undefined, `回执必须含 ${module} 行`);
    assert.equal(row.online_state, 'completed', `${module} 正文与台账都清了 ⇒ completed`);
    assert.equal(row.error_code, null, `${module} completed 时不得带阻断码`);
    assert.equal(row.backup_state, 'pending', `${module} 备份副本未接线 ⇒ 如实 pending，⛔ 不谎称完成`);
  }

  // 7) 审计读数与证据一致。
  const audit = deletion.audit().find((entry) => entry.module === RECOGNITIONS_DELETION_MODULE);
  assert.equal(audit.onlineRemoved, 3, '审计的 onlineRemoved 与证据串同一口径');
});

test('反向控制：store 缺按主体清空原语 ⇒ 处理器调用即抛、折叠 blocked（⛔ 不静默算完成）', async () => {
  const deletion = createUserDataDeletion({
    ...otherStores(),
    // 只有读路径、没有任何清空方法：模拟"表接了但原语忘了实现"的退化。
    recognitionsStore: { kind: 'broken-recognitions' },
  });
  const request = deletion.requestDeletionFor(USER_A);
  await deletion.executeHandlers(String(request.id));
  const row = deletion.receipt(String(request.id)).handlers
    .find((entry) => entry.module === RECOGNITIONS_DELETION_MODULE);
  assert.equal(row.online_state, 'blocked', '缺原语 ⇒ blocked（不是 completed，也不是"跳过"）');
  assert.equal(row.error_code, 'HANDLER_FAILED', '原因码由协议折叠为 HANDLER_FAILED');
  const evidence = deletion.evidenceOf(String(request.id))[RECOGNITIONS_DELETION_MODULE] ?? '';
  assert.equal(evidence.includes('recognitions:online-purged'), false, `没清就不能有清除证据：${evidence || '(无证据行)'}`);
});
