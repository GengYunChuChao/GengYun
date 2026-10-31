/**
 * GY-R72（#19 局部）· 注销链的**媒体域**在真 SQL 引擎上真被清过（PGlite 连库，不是内存替身）。
 *
 * 为什么需要这个文件：媒体清理的两半此前各自"看起来"都是通的——
 *   * `media/store-pg.ts::purgeOwnedMedia` 有实现，`tests/unit/privacy-media-purge.test.mjs`
 *     用假 client 钉住了语句顺序与参数；
 *   * `privacy/user-data-deletion.ts` 有 `mediaStore` 端口，识别域 handler 会把
 *     `media-hidden` / `media-objects-registered` 两条读数写进证据串。
 * 但装配层两处缺口让它们从未接上：`app.ts` 建 PG 媒体 store 时没传 `connect`
 * （原语直接 `PROVIDER_UNAVAILABLE`），注销协调器的实参里也没有 `mediaStore`
 * （`mediaReadings = null` ⇒ **静默跳过**，既不 blocked 也不 unsupported）。
 *
 * 本文件钉的就是"接上之后真的清"这一层：真 DDL（0001 的 `media` / `media_derivatives`
 * ＋ 0029 的 `media_object_cleanup`）、真 `UPDATE` / `DELETE` / `INSERT`，
 * 读数从**证据串**里读回来（不是从 store 的返回值另抄一份——那样接线断了也不会红）。
 *
 * 五条断言（顺序即事实链）：
 *   1. 读数 = `{ softHidden: 1, objectsRegistered: 4 }`（1 条社区图片 ⇒ 隐藏 1；
 *      1 个原对象键 + 3 个衍生物键 ⇒ 登记 4。⚠️ `objectsRegistered` 是"待删台账行数"，
 *      ⛔ 不是"已从桶里删掉几个"）；
 *   2. `media` 父行**依旧存在**（软隐藏：`state='deleted'` + 引用摘掉 + `revision+1`），
 *      ⛔ 不是物理删行；
 *   3. `media_derivatives` 物理删到 0；
 *   4. `media_object_cleanup` 出现对应意图行（摘要＝明文对象键的 sha256、`reason='owner_delete'`）；
 *   5. 二次调用幂等：读数归零、台账行数不增、父行仍是 1 行。
 * 另有一条跨主体断言（他人的行与对象键分毫不动）。
 *
 * ⛔ 本文件**不**证明（如实登记，别把它当已验）：
 *   * 桶里的对象已被删——`media/service.ts::cleanupOrphans` 今天**没有生产调用者**，
 *     台账行仍在，真正的桶删除要等重试器接线；
 *   * 真 PG17 下的**列权限**（`GRANT`/`42501`）——本机起不了真库，PGlite 里跑的是库属主连接，
 *     权限面由 `tests/integration/media-row-purge-pg.mjs` 那条真库臂覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createPostgresMediaStore } from '../../services/api/src/media/store-pg.ts';
import { createObjectRefCipher } from '../../services/api/src/media/object-ref-cipher.ts';
import {
  RECOGNITIONS_DELETION_MODULE,
  createUserDataDeletion,
} from '../../services/api/src/privacy/user-data-deletion.ts';
import { pglitePool } from './favorites-history-fixtures.mjs';

/** 0001 = `media` / `media_derivatives` 与两个枚举；0029 = 待清理对象台账。三张表缺一不可。 */
const MIGRATIONS = ['0001_initial_schema', '0029_media_object_cleanup'];
/** 32 字节键材料（`config.ts` 接受的 64 位 hex 形态），只在本进程内用。 */
const KEY = 'b'.repeat(64);
const USER_A = '0193a0f0-0000-4000-8000-00000000a001';
const USER_B = '0193a0f0-0000-4000-8000-00000000b002';

const countOf = async (db, sql, params = []) => Number((await db.query(sql, params)).rows[0].v);

/** 造一条持有对象键的媒体父行（形状取自 0001 的实测 DDL）。 */
async function insertMedia(db, { ownerId, purpose, state, objectRefCipher }) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO public.media (id, owner_id, purpose, mime, bytes, sha256, state, object_ref_cipher)
     VALUES ($1::uuid, $2::uuid, $3::public.media_purpose, 'image/jpeg', 1024, $4, $5::public.media_state, $6)`,
    [id, ownerId, purpose, 'a'.repeat(64), state, objectRefCipher],
  );
  return id;
}

/**
 * 把识别域证据串按 `;` 拆成"段名 → 段值"（`recognitions:media-hidden:1` ⇒ `media-hidden` → `1`）。
 *
 * 为什么不整串 `deepEqual`：媒体读数必须**真的来自原语返回**，逐段取值才能既钉住名字、又
 * 不让 `online-purged` / `idempotency-purged` 这些与媒体无关的段把断言连带钉死。
 */
function evidenceSegments(evidenceString) {
  const map = new Map();
  for (const segment of String(evidenceString).split(';')) {
    const matched = /^[a-z]+:([a-z-]+):(.*)$/.exec(segment);
    map.set(matched === null ? segment : matched[1], matched === null ? '' : matched[2]);
  }
  return map;
}

test('注销清空·媒体域：真 SQL 引擎上软隐藏 + 衍生物物理删 + 台账登记，读数如实进证据', async (t) => {
  const { db, pool } = await pglitePool(t, MIGRATIONS);
  const cipher = createObjectRefCipher(KEY);
  for (const userId of [USER_A, USER_B]) {
    await db.query('INSERT INTO users (id) VALUES ($1::uuid)', [userId]);
  }

  // A：一条社区图片，原对象键 1 个 + 三个衍生物对象键（衍生物行是**真行**，注销要物理删）。
  const rawRefA = 'obj:raw:a1';
  const derivativeRefs = ['obj:deriv:a1-1', 'obj:deriv:a1-2', 'obj:deriv:a1-3'];
  const mediaIdA = await insertMedia(db, {
    ownerId: USER_A,
    purpose: 'community_image',
    state: 'ready',
    objectRefCipher: cipher.encryptObjectRef(rawRefA),
  });
  const derivativeKinds = ['thumbnail', 'preview', 'mask'];
  for (const [index, objectRef] of derivativeRefs.entries()) {
    await db.query(
      `INSERT INTO public.media_derivatives (id, media_id, derivative_kind, object_ref_cipher, hash, state)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'ready')`,
      [
        randomUUID(),
        mediaIdA,
        derivativeKinds[index],
        cipher.encryptObjectRef(objectRef),
        String(index + 1).repeat(64),
      ],
    );
  }
  // B：同形的一行（同为社区图片）。注销 A 不得把它一起隐藏、更不能摘掉它的对象键。
  const rawRefB = 'obj:raw:b1';
  const mediaIdB = await insertMedia(db, {
    ownerId: USER_B,
    purpose: 'community_image',
    state: 'ready',
    objectRefCipher: cipher.encryptObjectRef(rawRefB),
  });

  assert.equal(await countOf(db, 'SELECT count(*)::int AS v FROM public.media WHERE owner_id = $1::uuid', [USER_A]), 1);
  assert.equal(
    await countOf(db, 'SELECT count(*)::int AS v FROM public.media_derivatives WHERE media_id = $1::uuid', [mediaIdA]),
    3,
  );
  assert.equal(await countOf(db, 'SELECT count(*)::int AS v FROM public.media_object_cleanup'), 0, '初始台账必须为空');

  // 装配：`connect` 是原语唯一的执行前提（缺它 ⇒ `PROVIDER_UNAVAILABLE`，一条语句都不发）。
  const mediaStore = createPostgresMediaStore({ pool, cipher, connect: () => pool.connect() });
  const deletion = createUserDataDeletion({
    favoritesStore: createMemoryFavoritesStore(),
    historyStore: createMemoryHistoryStore(),
    messagesStore: createMemoryMessagesStore(),
    conversationsStore: createMemoryConversationStore(),
    recognitionsStore: createMemoryRecognitionStore(),
    mediaStore,
  });
  const requestId = String(deletion.requestDeletionFor(USER_A).id);
  await deletion.executeHandlers(requestId);

  // ① 读数：来自原语真实返回，经识别域 handler 写进证据串。
  //    先取回执：读数断言失败时要能一眼看出"是根本没接上（该域 blocked）还是数不对"——
  //    否则"缺 connect"这种装配缺口只会在红里留一句 `undefined`，看不出根因。
  const handler = deletion.receipt(requestId).handlers
    .find((row) => row.module === RECOGNITIONS_DELETION_MODULE);
  const handlerState = handler === undefined ? '（回执里没有识别域）' : `${handler.online_state}/${handler.error_code}`;
  const evidence = deletion.evidenceOf(requestId);
  const recognitionEvidence = evidence[RECOGNITIONS_DELETION_MODULE];
  const readings = evidenceSegments(recognitionEvidence);
  assert.deepEqual(
    {
      softHidden: Number(readings.get('media-hidden')),
      objectsRegistered: Number(readings.get('media-objects-registered')),
    },
    { softHidden: 1, objectsRegistered: 4 },
    `媒体读数必须如实进证据串（1 条社区图片 ⇒ 隐藏 1；1 原对象 + 3 衍生物 ⇒ 登记 4）：${recognitionEvidence}`
      + `；识别域回执=${handlerState}`,
  );
  assert.equal(recognitionEvidence.includes('recognitions:blocked'), false, `正常路径不得折叠 blocked：${recognitionEvidence}`);
  assert.equal(handler.online_state, 'completed', '媒体清理接上后识别域必须 completed（缺 connect 时会 blocked）');
  assert.equal(handler.error_code, null);

  // ② 父行**不物理删**：软隐藏（行还在、引用摘掉、revision 推进）。
  const rowsA = (await db.query(
    `SELECT id::text AS id, state::text AS state, revision, object_ref_cipher
       FROM public.media WHERE owner_id = $1::uuid ORDER BY id`,
    [USER_A],
  )).rows;
  assert.equal(rowsA.length, 1, '媒体父行必须仍在（注销对媒体是软隐藏，不是物理删行）');
  assert.equal(rowsA[0].id, mediaIdA);
  assert.equal(rowsA[0].state, 'deleted', '社区图片必须离开公开面');
  assert.equal(Number(rowsA[0].revision), 2, '行内容变了 ⇒ revision 必须推进一次');
  assert.equal(cipher.decryptObjectRef(rowsA[0].object_ref_cipher), null, '父行不得再持有对象键');

  // ③ 衍生物行物理删到 0（三行全删，不是"标删"）。
  assert.equal(
    await countOf(db, 'SELECT count(*)::int AS v FROM public.media_derivatives WHERE media_id = $1::uuid', [mediaIdA]),
    0,
    '衍生物行必须物理删到 0',
  );

  // ④ 台账：每个对象键一条意图行（1 原对象 + 3 衍生物 = 4），摘要＝明文键的 sha256。
  const cleanup = (await db.query(
    `SELECT media_id::text AS media_id, object_ref_digest, reason, attempts, object_ref_cipher
       FROM public.media_object_cleanup ORDER BY object_ref_digest`,
  )).rows;
  const expectedDigests = new Map(
    [rawRefA, ...derivativeRefs].map((objectRef) => [
      createHash('sha256').update(objectRef, 'utf8').digest('hex'),
      objectRef,
    ]),
  );
  assert.equal(cleanup.length, 4, '台账必须登记 4 个对象键（⛔ 不是 3：原对象也欠着）');
  assert.deepEqual(
    cleanup.map((row) => String(row.object_ref_digest).trim()).sort(),
    [...expectedDigests.keys()].sort(),
    '登记的摘要必须是明文对象键的 sha256（唯一键，重试器靠它定位对象）',
  );
  for (const row of cleanup) {
    assert.equal(row.media_id, mediaIdA, '台账行必须指向被注销主体的媒体行');
    assert.equal(row.reason, 'owner_delete');
    assert.equal(Number(row.attempts), 1, '首次登记 attempts=1');
    // 密文列仍持明文可解的对象键（⛔ 明文不入库）。
    assert.equal(cipher.decryptObjectRef(row.object_ref_cipher), expectedDigests.get(String(row.object_ref_digest).trim()));
  }

  // ⑤ 幂等：二次调用读数归零、不新增台账行、父行仍是 1 行。
  assert.deepEqual(
    await mediaStore.purgeOwnedMedia(USER_A),
    { softHidden: 0, objectsRegistered: 0 },
    '二次调用没有可隐藏的行、也没有待登记的新对象键 ⇒ 读数归零（不是累计值）',
  );
  assert.equal(await countOf(db, 'SELECT count(*)::int AS v FROM public.media_object_cleanup'), 4, '二次调用不得让台账变多');
  assert.equal(
    await countOf(db, 'SELECT count(*)::int AS v FROM public.media WHERE owner_id = $1::uuid', [USER_A]),
    1,
    '二次调用不得删掉父行',
  );

  // 跨主体：B 的行分毫不动（清全部 ≠ 清本主体）。
  const rowB = (await db.query(
    'SELECT state::text AS state, revision, object_ref_cipher FROM public.media WHERE id = $1::uuid',
    [mediaIdB],
  )).rows[0];
  assert.equal(rowB.state, 'ready', '他人的行不得被软隐藏');
  assert.equal(Number(rowB.revision), 1, '他人的行 revision 不得被推进');
  assert.equal(cipher.decryptObjectRef(rowB.object_ref_cipher), rawRefB, '他人仍持有自己的对象键');
  assert.equal(
    await countOf(db, 'SELECT count(*)::int AS v FROM public.media_object_cleanup WHERE media_id = $1::uuid', [mediaIdB]),
    0,
    '他人的对象键不得进台账',
  );
});
