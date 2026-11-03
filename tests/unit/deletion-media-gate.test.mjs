/**
 * GY-R74 · 媒体域的「静默漏清」闸门（内存实现）。
 *
 * 为什么需要它：媒体对象清理端口只挂在**识别域**（`coordinator.registerModule(RECOGNITIONS_DELETION_MODULE,
 * makeHandler(..., input.mediaStore))` 是全仓唯一传第三参的注册）。而 real 模式缺 `MEDIA_OBJECT_REF_KEY` 时，
 * 装配层既不建 PG 媒体 store、也**不注入** `mediaStore`（`services/api/src/app.ts` 的
 * `mediaPersistenceRefusal` 分支）——此时识别域处理器照样跑完行删除，并照旧报 `online_state: 'completed'`：
 * 用户与审查者都会读到"已清除"，但**桶里的对象一个也没枚举到、更没删**。这是本片要堵的静默漏清。
 *
 * 口径（本文件钉住四条）：
 *   1. 闸门只在**媒体端口所在的那一域**生效（识别域）⇒ `blocked` + `PROVIDER_UNAVAILABLE`，且**不写**在线证据；
 *   2. 其余各域读数**不受影响**（照常 `completed`）——⛔ 不许用媒体缺口把八域真实读数一起抹掉；
 *   3. 行删除**照常发生**（闸门不是"跳过删除"，是"不许把没验过的清空当完成"）；
 *   4. 注入了真实媒体端口 ⇒ 端口优先，闸门不生效（否则等于把可用的装配也一起降级）。
 *
 * 真库侧的同一口径见 `tests/integration/account-deletion-pg.mjs` 的 real 臂 (e)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import {
  RECOGNITIONS_DELETION_MODULE,
  USER_DATA_DELETION_MODULES,
  createUserDataDeletion,
} from '../../services/api/src/privacy/user-data-deletion.ts';
import { scriptedClock } from './favorites-history-fixtures.mjs';

const USER_A = '0193a0f0-0000-4000-8000-00000000c001';
const USER_B = '0193a0f0-0000-4000-8000-00000000d002';
const AT = new Date('2026-11-03T03:00:00.000Z');
const LATER = new Date('2026-11-03T04:00:00.000Z');

/** 与 `services/api/src/app.ts` 里 `mediaPersistenceRefusal` 的文案同源，逐字取自装配层。 */
const MEDIA_REFUSAL =
  'real 模式的媒体持久化缺少 MEDIA_OBJECT_REF_KEY：object_ref_cipher 无法加密，拒绝以进程内状态承载媒体事实';

function otherStores() {
  const clock = scriptedClock();
  return {
    favoritesStore: createMemoryFavoritesStore({ now: () => clock.ms }),
    historyStore: createMemoryHistoryStore({ now: () => clock.ms }),
    messagesStore: createMemoryMessagesStore({ now: () => clock.ms }),
    conversationsStore: createMemoryConversationStore(),
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

/** 每个主体一条识别记录：够让识别域处理器真的跑一遍行删除。 */
async function seedRecognitions() {
  const recognitions = createMemoryRecognitionStore();
  await recognitions.insertRecognition(recognitionRow('rec-a', USER_A));
  await recognitions.insertRecognition(recognitionRow('rec-b', USER_B));
  return recognitions;
}

/** 证据端口替身：记录每个域被写了几次（形状与 `OnlinePurgeEvidenceRecorder` 对齐）。 */
function evidenceSpy() {
  const written = [];
  return {
    written,
    port: {
      kind: 'postgres',
      available: true,
      async record(input) {
        written.push(input);
      },
      async recordVerifiedEmpty(input) {
        written.push(input);
        return 'recorded';
      },
    },
  };
}

function coresOf(deletion, requestId) {
  const receipt = deletion.receipt(String(requestId));
  const rows = new Map(receipt.handlers.map((row) => [row.module, row]));
  return rows;
}

test('GY-R74 媒体门只在识别域：缺 MEDIA_OBJECT_REF_KEY ⇒ 识别域 blocked + PROVIDER_UNAVAILABLE，且不写在线证据', async () => {
  const recognitions = await seedRecognitions();
  const evidence = evidenceSpy();
  const deletion = createUserDataDeletion({
    ...otherStores(),
    recognitionsStore: recognitions,
    onlineEvidence: evidence.port,
    mediaPurgeUnavailable: MEDIA_REFUSAL,
  });

  const request = deletion.requestDeletionFor(USER_A);
  await deletion.executeHandlers(String(request.id));

  const rows = coresOf(deletion, request.id);
  const recognitionRowResult = rows.get(RECOGNITIONS_DELETION_MODULE);
  assert.ok(recognitionRowResult !== undefined, '识别域必须在闭集里');
  assert.equal(
    recognitionRowResult.online_state,
    'blocked',
    '缺媒体密钥 ⇒ 桶对象既枚举不到也删不掉：⛔ 不得报 completed（那正是静默漏清）',
  );
  assert.equal(
    recognitionRowResult.error_code,
    'PROVIDER_UNAVAILABLE',
    '原因码取 SAFE_ERROR_CODES 闭集内的 PROVIDER_UNAVAILABLE（不新增原因码、不触发锚点账）',
  );
  assert.equal(
    recognitionRowResult.backup_state,
    'pending',
    '闸门只落在在线列：备份副本域仍未接线 ⇒ 如实 pending（⛔ 不借机改成 completed/blocked 冒充）',
  );

  // 证据：识别域一条都不许写（写了就等于对外宣称"这一域已清空并留证"）。
  const recognitionEvidence = evidence.written.filter((entry) => entry.module === RECOGNITIONS_DELETION_MODULE);
  assert.equal(
    recognitionEvidence.length,
    0,
    `识别域不得写在线清除证据（实际写了 ${recognitionEvidence.length} 条）`,
  );

  // 其余各域读数不受影响：闸门不是"整域降级"。
  for (const module of USER_DATA_DELETION_MODULES) {
    const row = rows.get(module);
    assert.ok(row !== undefined, `回执必须含 ${module} 行`);
    assert.equal(row.online_state, 'completed', `${module} 与媒体端口无关 ⇒ 照常 completed`);
    assert.equal(row.error_code, null, `${module} completed 时不得带阻断码`);
    assert.ok(
      evidence.written.some((entry) => entry.module === module),
      `${module} 真的清了就必须留下证据`,
    );
  }

  // 闸门不是"跳过删除"：行照常物理删除，别人的行原样。
  assert.equal(await recognitions.getRecognition('rec-a'), null, '识别记录必须仍然被删除（闸门只改口径，不改动作）');
  const otherRow = await recognitions.getRecognition('rec-b');
  assert.ok(otherRow !== null, '他人的识别记录不得被带走');
  assert.equal(otherRow.ownerUserId, USER_B);
});

test('GY-R74 反向控制：没有闸门（装配了可用媒体端口或未开 real）⇒ 识别域照常 completed 并写证据', async () => {
  const recognitions = await seedRecognitions();
  const evidence = evidenceSpy();
  const deletion = createUserDataDeletion({
    ...otherStores(),
    recognitionsStore: recognitions,
    onlineEvidence: evidence.port,
    // 不传 `mediaPurgeUnavailable`：等价于"媒体持久化可用"的非 real 装配。
  });

  const request = deletion.requestDeletionFor(USER_A);
  await deletion.executeHandlers(String(request.id));

  const row = coresOf(deletion, request.id).get(RECOGNITIONS_DELETION_MODULE);
  assert.equal(row.online_state, 'completed', '没有媒体缺口 ⇒ 识别域如实 completed');
  assert.equal(row.error_code, null);
  assert.equal(
    evidence.written.filter((entry) => entry.module === RECOGNITIONS_DELETION_MODULE).length,
    1,
    '清除成功就必须写一条识别域证据（负控制：把闸门写成"永远 blocked"会让本条红）',
  );
});

test('GY-R74 端口优先：注入了真实媒体端口 ⇒ 闸门不生效（否则可用装配被一起降级）', async () => {
  const recognitions = await seedRecognitions();
  const evidence = evidenceSpy();
  const purged = [];
  const deletion = createUserDataDeletion({
    ...otherStores(),
    recognitionsStore: recognitions,
    onlineEvidence: evidence.port,
    mediaStore: {
      async purgeOwnedMedia(ownerId) {
        purged.push(ownerId);
        // 形状同 `MediaPurgePort`：软隐藏行数 + **台账登记**数（⛔ 不是"已从桶里删除"）。
        return { softHidden: 1, objectsRegistered: 2 };
      },
    },
    // 装配层即使同时给了拒绝原因，只要端口在，就不该把可用的那一臂按缺口处理。
    mediaPurgeUnavailable: MEDIA_REFUSAL,
  });

  const request = deletion.requestDeletionFor(USER_A);
  await deletion.executeHandlers(String(request.id));

  assert.deepEqual(purged, [USER_A], '媒体端口必须被真的调用一次（只对本主体）');
  const row = coresOf(deletion, request.id).get(RECOGNITIONS_DELETION_MODULE);
  assert.equal(row.online_state, 'completed', '端口可用 ⇒ 由端口读数决定，闸门不得抢戏');
  assert.equal(row.error_code, null);
  const recognitionEvidence = evidence.written.filter((entry) => entry.module === RECOGNITIONS_DELETION_MODULE);
  assert.equal(recognitionEvidence.length, 1, '端口跑通 ⇒ 证据照写');
});

test('GY-R74 闸门不扩大：识别域以外的域即使缺媒体密钥也不得被改口径', async () => {
  const recognitions = await seedRecognitions();
  const evidence = evidenceSpy();
  const deletion = createUserDataDeletion({
    ...otherStores(),
    recognitionsStore: recognitions,
    onlineEvidence: evidence.port,
    mediaPurgeUnavailable: MEDIA_REFUSAL,
  });

  const request = deletion.requestDeletionFor(USER_A);
  await deletion.executeHandlers(String(request.id));

  const rows = coresOf(deletion, request.id);
  const blockedModules = [...rows.values()].filter((row) => row.online_state === 'blocked').map((row) => row.module);
  assert.deepEqual(
    blockedModules,
    [RECOGNITIONS_DELETION_MODULE],
    '缺媒体密钥只影响媒体端口所在的那一域（扩到其它域会抹掉它们真实的删除读数）',
  );
});
