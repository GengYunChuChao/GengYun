/**
 * GY-R68 · 媒体对象清理接进注销闭集（前两半：store 原语 + 服务层，**装配留待下一片**）。
 *
 * 为什么需要它：注销闭集里原先只有一条注释占位——「关联的 `media` 对象由媒体域另行清理
 * （本片不接管）」。占位的问题不是"少写了一个数"，而是**回执里根本没有媒体这一项**：
 * 一个主体注销完，社区图片还在桶里、行还是 `ready`，而回执照样 `completed`。
 * 本片补的是原语（`media/store.ts::purgeOwnedMedia`）＋服务层的读数接线，因此必须钉住四件事：
 *
 *   1. 读数来自原语的**真实返回**：换一组假读数，证据串就跟着变（⛔ 不是写死常量）；
 *   2. 证据只报**本主体**这一次的清法：`media-hidden`（社区图片软隐藏数）与
 *      `media-objects-registered`（**登记进待删台账**的对象键数，⛔ 不是"已从桶里删掉"）分列，
 *      ⛔ 不合并成一个数、不并进 `online-purged`；
 *   3. 空 / 非法主体**不调原语**（空主体="不知道清谁"，绝不能变成"清全部"）；
 *   4. 清理失败时回执如实 `blocked` + 固定原因码，⛔ 不静默吞掉、⛔ 不留假证据，
 *      且**本域一行都没删**（媒体清理排在 `purgeOwnerData` 之前——这条排序有专门用例守）；
 *   5. PG 实现（`media/store-pg.ts`）的**语句顺序与参数**用假 client 钉住（`::fake-client` 用例）。
 *
 * ⚠️ 真库路径**本片未覆盖**：`tests/integration/**` 里没有任何 `purgeOwnedMedia` 的连库用例
 * （连库臂 `tests/integration/media-purge-pg.mjs` 留待装配片）。这里只跑内存实现、假 store 与假 client。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createMemoryMediaStore } from '../../services/api/src/media/store.ts';
import { createPostgresMediaStore } from '../../services/api/src/media/store-pg.ts';
import { createObjectRefCipher } from '../../services/api/src/media/object-ref-cipher.ts';
import {
  RECOGNITIONS_DELETION_MODULE,
  USER_DATA_DELETION_MODULES,
  createUserDataDeletion,
} from '../../services/api/src/privacy/user-data-deletion.ts';
import { ApiError } from '../../services/api/src/errors.ts';

const USER_A = '0193a0f0-0000-4000-8000-00000000a001';
const USER_B = '0193a0f0-0000-4000-8000-00000000b002';
const AT = Date.parse('2026-10-28T03:00:00.000Z');
const LATER = Date.parse('2026-10-28T04:00:00.000Z');

/** 四域只需"不缺席"，本片不碰它们的内容。 */
function otherStores() {
  return {
    favoritesStore: createMemoryFavoritesStore({ now: () => AT }),
    historyStore: createMemoryHistoryStore({ now: () => AT }),
    messagesStore: createMemoryMessagesStore({ now: () => AT }),
    conversationsStore: createMemoryConversationStore(),
  };
}

/**
 * 假 store：只实现注销闭集用得到的那一个方法，并记下被调用时的主体。
 *
 * `readings` 是 `{ softHidden, objectsRegistered }` 或一个**要抛的**错误实例——
 * 两种形态分别驱动"读数接线"与"失败不吞"两条断言。
 */
function fakeMediaStore(readings) {
  const calls = [];
  return {
    calls,
    async purgeOwnedMedia(ownerId) {
      calls.push(ownerId);
      if (readings instanceof Error) throw readings;
      return readings;
    },
  };
}

function mediaRecord(overrides) {
  return {
    id: 'media-a1',
    ownerId: USER_A,
    revision: 1,
    purpose: 'community_image',
    mime: 'image/jpeg',
    bytes: 1024,
    duration_ms: null,
    sha256: 'a'.repeat(64),
    state: 'ready',
    failure_code: null,
    rawRef: 'obj:raw:a1',
    derivativeRef: 'obj:deriv:a1',
    createdAt: AT,
    updatedAt: AT,
    expiresAt: LATER,
    ...overrides,
  };
}

/** 识别记录行（形状照 `services/api/src/recognitions/store.ts::RecognitionRow`）。 */
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

test('证据：两条读数来自原语返回（换假读数就跟着变），且不动闭合域闭集', async () => {
  const media = fakeMediaStore({ softHidden: 4, objectsRegistered: 7 });
  const deletion = createUserDataDeletion({
    ...otherStores(),
    recognitionsStore: createMemoryRecognitionStore(),
    mediaStore: media,
  });
  // 媒体清理不是**新域**：它挂在识别域处理器上，闭集不因此多一项。
  assert.deepEqual(
    deletion.requiredModules(),
    [...USER_DATA_DELETION_MODULES, RECOGNITIONS_DELETION_MODULE],
    '注入媒体端口不得扩出第五个域（媒体行没有自己的处理器行）',
  );

  const request = deletion.requestDeletionFor(USER_A);
  await deletion.executeHandlers(String(request.id));

  assert.deepEqual(media.calls, [USER_A], '原语必须收到本主体，且只调用一次');
  const evidence = deletion.evidenceOf(String(request.id))[RECOGNITIONS_DELETION_MODULE] ?? '';
  assert.ok(evidence.includes('recognitions:media-hidden:4'), `软隐藏读数必须进证据：${evidence}`);
  assert.ok(
    evidence.includes('recognitions:media-objects-registered:7'),
    `对象登记读数必须进证据：${evidence}`,
  );
  // 两个读数分列：⛔ 不合并、⛔ 不并进 online-purged 冒充"行都删完了"。
  assert.equal(evidence.includes('media-hidden:4;recognitions:media-objects-registered:7'), true);
  // ⛔ 名字必须诚实：本原语一次 `deleteObject` 都没调，不许说 purged。
  assert.equal(evidence.includes('objects-purged'), false, `证据不得声称对象已从桶里删除：${evidence}`);

  const row = deletion.receipt(String(request.id)).handlers
    .find((entry) => entry.module === RECOGNITIONS_DELETION_MODULE);
  assert.equal(row.online_state, 'completed');
  assert.equal(row.error_code, null);
});

test('证据：读数不是常量 —— 同一份代码换一组假读数，证据串逐字跟着变', async () => {
  const media = fakeMediaStore({ softHidden: 1, objectsRegistered: 2 });
  const deletion = createUserDataDeletion({
    ...otherStores(),
    recognitionsStore: createMemoryRecognitionStore(),
    mediaStore: media,
  });
  const request = deletion.requestDeletionFor(USER_A);
  await deletion.executeHandlers(String(request.id));
  const evidence = deletion.evidenceOf(String(request.id))[RECOGNITIONS_DELETION_MODULE] ?? '';
  assert.ok(evidence.includes('recognitions:media-hidden:1'), evidence);
  assert.ok(evidence.includes('recognitions:media-objects-registered:2'), evidence);
  assert.equal(evidence.includes('media-hidden:4'), false, '⛔ 不得残留上一组读数（那说明写死了常量）');
});

test('未注入媒体端口 ⇒ 证据串逐字保持本片之前的样子（不加空读数）', async () => {
  const deletion = createUserDataDeletion({
    ...otherStores(),
    recognitionsStore: createMemoryRecognitionStore(),
  });
  const request = deletion.requestDeletionFor(USER_A);
  await deletion.executeHandlers(String(request.id));
  const evidence = deletion.evidenceOf(String(request.id))[RECOGNITIONS_DELETION_MODULE] ?? '';
  assert.equal(evidence.includes('media-hidden'), false, evidence);
  assert.equal(evidence.includes('media-objects-registered'), false, evidence);
});

test('空 / 非法主体：闭集根本走不到原语（受理即拒），原语自己也拒跑', async () => {
  const media = fakeMediaStore({ softHidden: 3, objectsDeleted: 3 });
  const deletion = createUserDataDeletion({
    ...otherStores(),
    recognitionsStore: createMemoryRecognitionStore(),
    mediaStore: media,
  });
  // ① 受理层：空主体直接被拒，请求根本没建 ⇒ 原语不会被调用。
  assert.throws(() => deletion.requestDeletionFor(''), /非空主体/);
  assert.deepEqual(media.calls, [], '空主体不得触达媒体清理原语');

  // ② 原语层：空 / 纯空白 / 非 uuid 一律抛 INVALID_REQUEST（⛔ 不退化成"清全部"）。
  const store = createMemoryMediaStore({ now: () => AT });
  await assert.rejects(
    () => store.purgeOwnedMedia(''),
    (error) => error instanceof ApiError && error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    () => store.purgeOwnedMedia('   '),
    (error) => error instanceof ApiError && error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    () => store.purgeOwnedMedia('not-a-uuid'),
    (error) => error instanceof ApiError && error.code === 'INVALID_REQUEST',
  );
});

test('清理失败：本域一行都没删（媒体清理排在删行之前）+ 回执如实 blocked、不留假证据', async () => {
  const failure = new ApiError('PROVIDER_UNAVAILABLE', '媒体对象清理失败：对象存储不可达');
  const media = fakeMediaStore(failure);
  const recognitions = createMemoryRecognitionStore();
  // 先给本主体种**一行真的识别记录**：媒体清理失败时它必须原样还在。
  // 没有这一行，删 0 行与删 N 行看起来一样 ⇒ 排序变异（把媒体清理挪到 `purgeOwnerData` 之后）会全绿。
  await recognitions.insertRecognition(recognitionRow('rec-a', USER_A));
  const deletion = createUserDataDeletion({
    ...otherStores(),
    recognitionsStore: recognitions,
    mediaStore: media,
  });
  const request = deletion.requestDeletionFor(USER_A);
  await deletion.executeHandlers(String(request.id));

  assert.deepEqual(media.calls, [USER_A], '失败路径也必须确实尝试过清理');
  // ★ 本片的中心声明：媒体清理在 `purgeOwnerData` **之前** ⇒ 它抛错时识别域一行都没删。
  const survivor = await recognitions.getRecognition('rec-a');
  assert.notEqual(survivor, null, '媒体清理失败 ⇒ 识别域的行不得先被删掉（顺序：先清媒体，再删本域行）');
  assert.equal(survivor.deleted, false, '失败不得留下「已标记删除」的半截状态');
  assert.equal(survivor.revision, 1, '失败不得推进 revision（没删就没改）');
  const receipt = deletion.receipt(String(request.id));
  const row = receipt.handlers.find((entry) => entry.module === RECOGNITIONS_DELETION_MODULE);
  assert.equal(row.online_state, 'blocked', '清理失败 ⇒ 不得报 completed');
  assert.equal(row.error_code, 'PROVIDER_UNAVAILABLE', '失败原因以固定安全码进回执');
  assert.equal(row.evidence_ref ?? null, null, '失败不得留证据（没清完就没有凭据）');

  const evidence = deletion.evidenceOf(String(request.id))[RECOGNITIONS_DELETION_MODULE] ?? '';
  assert.equal(evidence.includes('media-hidden'), false, `失败不得写读数：${evidence}`);
  // 原始异常文本不进用户回执（可能含私有信息）：只映射成固定分类。
  assert.equal(
    JSON.stringify(receipt).includes('对象存储不可达'),
    false,
    '原始异常文本不得进回执',
  );
});

test('原语：只软隐藏本主体的社区图片、只摘本主体的对象引用（内存实现与真库同语义）', async () => {
  const store = createMemoryMediaStore({ now: () => AT });
  await store.createMedia(mediaRecord({ id: 'media-a1' }));
  await store.createMedia(mediaRecord({
    id: 'media-a2',
    purpose: 'weed_recognition',
    rawRef: 'obj:raw:a2',
    derivativeRef: null,
  }));
  await store.createMedia(mediaRecord({
    id: 'media-b1',
    ownerId: USER_B,
    rawRef: 'obj:raw:b1',
    derivativeRef: 'obj:deriv:b1',
  }));

  const first = await store.purgeOwnedMedia(USER_A);
  assert.deepEqual(first, { softHidden: 1, objectsRegistered: 3 }, 'a1 原对象+衍生物 2 个、a2 原对象 1 个');

  const a1 = await store.getMedia('media-a1');
  assert.equal(a1.state, 'deleted', '社区图片必须软隐藏');
  assert.equal(a1.rawRef, null, '对象引用必须摘掉');
  assert.equal(a1.derivativeRef, null);
  assert.ok(a1.revision > 1, '行内容变了 ⇒ revision 必须推进（迟到的写会拿 REVISION_CONFLICT）');
  const a2 = await store.getMedia('media-a2');
  assert.equal(a2.state, 'ready', '非社区图片不软隐藏（它的终态由它自己的删除路径决定）');
  assert.equal(a2.rawRef, null, '但对象引用同样按主体摘掉');
  const b1 = await store.getMedia('media-b1');
  assert.equal(b1.state, 'ready', '别人的行不许被这条路径碰到');
  assert.equal(b1.rawRef, 'obj:raw:b1');

  const cleanup = await store.listObjectCleanup();
  assert.deepEqual(
    cleanup.map((entry) => entry.objectRef).sort(),
    ['obj:deriv:a1', 'obj:raw:a1', 'obj:raw:a2'],
    '摘掉的对象必须登记进待删台账（桶删除由重试器按台账做）',
  );
  assert.equal(cleanup.every((entry) => entry.reason === 'owner_delete'), true);

  // 幂等：第二次没有可改的行 ⇒ 两个读数都归零（不是累计值）。
  assert.deepEqual(await store.purgeOwnedMedia(USER_A), { softHidden: 0, objectsRegistered: 0 });
  assert.equal(await store.liveCommunityImageCount(USER_A), 0, '注销后该主体的社区图片读数必须归零');
  assert.equal(await store.liveCommunityImageCount(USER_B), 1, '他人读数不受影响');
});

/**
 * `::fake-client` —— PG 实现（`media/store-pg.ts::purgeOwnedMedia`）的**语句顺序与参数**钉子，不连库。
 *
 * 为什么要有它：真库臂（`tests/integration/media-purge-pg.mjs`）留待装配片，本片若不钉，
 * 「单事务 / 先软隐藏再摘对象 / 按 owner_id 收窄 / 不重复清社区图片行」四条全是口头的。
 * 假 client 逐条记录语句，用它钉住：
 *   ① 第一条是 `BEGIN`、最后一条是 `COMMIT`（中途失败走 `ROLLBACK`），且**只在事务连接上**发语句
 *      （池上直接 query 等于每条各自自动提交 ⇒ 假池一被调用就抛错）；
 *   ② 读该 owner 的媒体行（`WHERE owner_id = $1`，参数就是本主体）；
 *   ③ 读这些媒体 id 的衍生物行（`media_id = ANY($1::uuid[])`）；
 *   ④ 软隐藏 `UPDATE … state = 'deleted'::media_state … RETURNING id`，参数 `[owner, [社区图片 id], 空密文]`；
 *   ⑤ 每个对象键一条 7 列 `INSERT … ON CONFLICT (object_ref_digest) DO UPDATE … attempts + 1`；
 *   ⑥ 清引用 `UPDATE public.media SET object_ref_cipher = $3` 只装**非**社区图片行（社区图片在 ④ 已清，
 *      重复推进会白抬一次 `revision`）；
 *   ⑦ `DELETE FROM public.media_derivatives` 只按该 owner 的媒体 id。
 */
test('PG 原语 ::fake-client：单事务 + 四条语句的顺序/参数/收窄，社区图片行不被重复清', async () => {
  const cipher = createObjectRefCipher('a'.repeat(64));
  const mediaRows = [
    {
      id: 'media-a1',
      purpose: 'community_image',
      state: 'ready',
      object_ref_cipher: cipher.encryptObjectRef('obj:raw:a1'),
    },
    {
      id: 'media-a2',
      purpose: 'weed_recognition',
      state: 'ready',
      object_ref_cipher: cipher.encryptObjectRef('obj:raw:a2'),
    },
  ];
  const derivativeRows = [
    { media_id: 'media-a1', object_ref_cipher: cipher.encryptObjectRef('obj:deriv:a1') },
  ];

  const statements = [];
  let released = 0;
  const client = {
    async query(text, values) {
      const trimmed = text.trim();
      statements.push({ text: trimmed, values: values ?? [] });
      if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
        return { rows: [] };
      }
      if (trimmed.includes('FROM public.media WHERE owner_id = $1')) return { rows: mediaRows };
      if (trimmed.includes('SELECT media_id, object_ref_cipher')) return { rows: derivativeRows };
      if (trimmed.includes("state = 'deleted'::media_state")) {
        return { rows: (values[1] ?? []).map((id) => ({ id })) };
      }
      if (trimmed.startsWith('INSERT INTO public.media_object_cleanup')) return { rows: [] };
      if (trimmed.startsWith('UPDATE public.media SET object_ref_cipher = $3')) return { rows: [] };
      if (trimmed.startsWith('DELETE FROM public.media_derivatives')) return { rows: [] };
      throw new Error(`假 client 收到未预期的语句：${trimmed.slice(0, 60)}`);
    },
    release() { released += 1; },
  };
  let poolQueries = 0;
  const store = createPostgresMediaStore({
    pool: {
      async query() {
        poolQueries += 1;
        throw new Error('purgeOwnedMedia 不得在池上直接执行语句（那会变成各语句自动提交）');
      },
    },
    cipher,
    connect: async () => client,
  });

  const result = await store.purgeOwnedMedia(USER_A);
  assert.deepEqual(result, { softHidden: 1, objectsRegistered: 3 }, 'a1 原对象+衍生物、a2 原对象');
  assert.equal(poolQueries, 0, '必须全部走事务连接，池上一次都不许发');
  assert.equal(released, 1, '事务连接必须释放一次（成功路径）');

  const texts = statements.map((entry) => entry.text);
  assert.equal(texts[0], 'BEGIN', '单事务：第一条必须是 BEGIN');
  assert.equal(texts[texts.length - 1], 'COMMIT', '单事务：最后一条必须是 COMMIT');
  assert.equal(texts.filter((text) => text === 'COMMIT').length, 1, '只许一个 COMMIT');
  assert.equal(texts.includes('ROLLBACK'), false, '成功路径不得回滚');

  const indexOf = (predicate) => texts.findIndex(predicate);
  const selectMediaIndex = indexOf((text) => text.includes('FROM public.media WHERE owner_id = $1'));
  const selectDerivativesIndex = indexOf((text) => text.includes('SELECT media_id, object_ref_cipher'));
  const softHideIndex = indexOf((text) => text.includes("state = 'deleted'::media_state"));
  const insertIndex = indexOf((text) => text.startsWith('INSERT INTO public.media_object_cleanup'));
  const clearIndex = indexOf((text) => text.startsWith('UPDATE public.media SET object_ref_cipher = $3'));
  const deleteIndex = indexOf((text) => text.startsWith('DELETE FROM public.media_derivatives'));

  for (const [name, index] of [
    ['读媒体行', selectMediaIndex],
    ['读衍生物行', selectDerivativesIndex],
    ['软隐藏', softHideIndex],
    ['登记台账', insertIndex],
    ['清引用', clearIndex],
    ['删衍生物', deleteIndex],
  ]) {
    assert.notEqual(index, -1, `缺了「${name}」这条语句：${JSON.stringify(texts, null, 2)}`);
  }
  // 顺序：软隐藏 → 登记台账 → 清引用 → 删衍生物（不许反过来，也不许登记早于软隐藏）。
  assert.ok(softHideIndex < insertIndex, '必须先软隐藏、再登记台账');
  assert.ok(insertIndex < clearIndex, '必须先登记台账、再清引用');
  assert.ok(clearIndex < deleteIndex, '先清引用、再删衍生物行');
  assert.ok(selectMediaIndex < softHideIndex, '对象键必须取软隐藏**之前**的快照，否则键会丢');

  // ① 软隐藏：按 owner_id + 社区图片 id 收窄，写空明文密文（`decrypt` 还原 null）。
  const softHide = statements[softHideIndex];
  assert.deepEqual(softHide.values[0], USER_A, '软隐藏必须按本主体收窄');
  assert.deepEqual(softHide.values[1], ['media-a1'], '只软隐藏社区图片行');
  assert.equal(cipher.decryptObjectRef(softHide.values[2]), null, '清引用写的是「空明文密文」，不是明文空串');
  assert.equal(softHide.text.includes('RETURNING id'), true, '软隐藏用 RETURNING 取真实隐藏行数');
  assert.equal(softHide.text.includes('revision = revision + 1'), true, '行内容变了 ⇒ revision 必须推进');

  // ② 台账登记：每个对象键一条 7 列 INSERT … ON CONFLICT。
  const inserts = statements.filter((entry) => entry.text.startsWith('INSERT INTO public.media_object_cleanup'));
  assert.equal(inserts.length, 3, '三个对象键各登记一条（a1 原对象、a1 衍生物、a2 原对象）');
  const inserted = [];
  for (const entry of inserts) {
    for (const column of [
      'media_id', 'object_ref_cipher', 'object_ref_digest', 'reason', 'attempts', 'created_at', 'updated_at',
    ]) {
      assert.equal(entry.text.includes(column), true, `INSERT 必须显式列出「${column}」列（列级授权靠它核对）`);
    }
    assert.equal(entry.text.includes('ON CONFLICT (object_ref_digest) DO UPDATE SET'), true);
    assert.equal(entry.text.includes('public.media_object_cleanup.attempts + 1'), true);
    assert.equal(entry.values[3], undefined, 'reason 是字面量 owner_delete，不走参数');
    const objectRef = cipher.decryptObjectRef(entry.values[1]);
    assert.equal(
      entry.values[2],
      createHash('sha256').update(String(objectRef), 'utf8').digest('hex'),
      'object_ref_digest 必须是明文对象键的 sha256（台账唯一键，用来去重与重放）',
    );
    inserted.push({ mediaId: entry.values[0], objectRef });
  }
  assert.deepEqual(
    inserted,
    [
      { mediaId: 'media-a1', objectRef: 'obj:raw:a1' },
      { mediaId: 'media-a1', objectRef: 'obj:deriv:a1' },
      { mediaId: 'media-a2', objectRef: 'obj:raw:a2' },
    ],
    '登记顺序＝行序 × (原对象, 衍生物)',
  );
  assert.equal(inserts[0].text.includes("'owner_delete'"), true, 'reason 必须是 owner_delete');

  // ③ 清引用：只装非社区图片行 ⇒ 社区图片（已在 ① 清过）不被重复推进 revision。
  const clear = statements[clearIndex];
  assert.deepEqual(clear.values[0], USER_A);
  assert.deepEqual(clear.values[1], ['media-a2'], '社区图片行不得在这里被再清一次');
  assert.equal(clear.values[1].includes('media-a1'), false);
  assert.equal(cipher.decryptObjectRef(clear.values[2]), null);

  // ④ 删衍生物：按该 owner 的媒体 id 收窄（无跨主体删行路径）。
  const remove = statements[deleteIndex];
  assert.deepEqual(remove.values[0], ['media-a1', 'media-a2']);
  assert.equal(remove.text.includes('WHERE media_id = ANY($1::uuid[])'), true);

  // ⑤ 读行也按 owner 收窄（别人的行根本不进内存）。
  assert.deepEqual(statements[selectMediaIndex].values, [USER_A]);
  // 衍生物行按「该 owner 的**全部**媒体 id」取（含不软隐藏的行：它们的衍生物同样要登记）。
  assert.deepEqual(statements[selectDerivativesIndex].values, [['media-a1', 'media-a2']]);
});

test('PG 原语 ::fake-client：未注入 connect ⇒ fail-closed（零语句、不伪事务）', async () => {
  const cipher = createObjectRefCipher('a'.repeat(64));
  let poolQueries = 0;
  const store = createPostgresMediaStore({
    pool: { async query() { poolQueries += 1; return { rows: [] }; } },
    cipher,
  });
  await assert.rejects(
    () => store.purgeOwnedMedia(USER_A),
    (error) => error instanceof ApiError && error.code === 'PROVIDER_UNAVAILABLE',
  );
  assert.equal(poolQueries, 0, '没有事务连接就一条语句都不许发（不做伪事务）');
});
