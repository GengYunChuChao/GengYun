/**
 * GY-R31 · F13 P2 返修（PR #483 · 监工 [P2] 的**残留 fail-open**）：读数不可信 ⇒ **一律 blocked**。
 *
 * 背景（对抗性审查记录，reviewed_sha=`77074ad9` 之后仍成立）：
 *   `77074ad9` 已把主判据改成「清理后同事务重测 `authorRefsRemaining`」，主缺陷（软删行仍关联
 *   原作者却报 completed）已修。但只要存储**不报告** `authorRefsRemaining`（或报出非数/非整数/
 *   负数/非有限值），端口就回落到旧判据 `authorRefsReplaced === 0` ⇒ 审查探针 P6 实测仍会静默
 *   `completed`，P6b 实测 `"3" / -1 / 1.5 / NaN / Infinity` 也一律回落 ⇒ `blocked = 0`。
 *
 * 监工批语（本文件要钉死的口径）：
 *   「已软删除帖评仍保留原作者关联，社区去身份回执却可能报告 completed，存在隐私与完成状态失真。」
 *
 * 结论：**证明不了已清干净，就不能说完成了**。本文件断言：
 *   A. 读数缺席 / `undefined` / `null` / `"3"` / `-1` / `1.5` / `NaN` / `±Infinity` / 2^53 等
 *      一律 ⇒ `blocked = 1` + `author-refs-remaining-unknown`，⛔ 不得 completed；
 *   B. 旧保底判据（`authorRefsReplaced===0`）**已彻底删除**：即使它以前会命中，原因码也必须是
 *      「读数未知」而不是「还有行没换」（否则等于把 fail-open 换了个马甲）；
 *   C. 走**真实注销协调器**：存储不报告该读数时，社区回执 `online_state = 'blocked'`（P6 探针）；
 *   D. 正常读数 `0` ⇒ completed（⛔ 不许把正常路径也弄成 blocked），`>0` ⇒ blocked（既有语义）；
 *   E. PG 实现（store-pg）测量不可读时**报 unknown 哨兵**，⛔ 不得把「没读到」当成 0；
 *      正常 0 行 / 1 行仍如实。内存实现（store）由构造保证恒报非负安全整数，D 用真实实现跑通。
 *
 * 口径声明：本文件只证明**端口判据**与两侧实现的读数契约，不构成真实 PG 17 验收：
 * 真库臂仍是 `tests/integration/community-pg.mjs`（未设 `COMMUNITY_PG_TEST_URL` ⇒ EXITCODE=77）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import {
  COMMUNITY_DELETION_MODULE,
  createUserDataDeletion,
} from '../../services/api/src/privacy/user-data-deletion.ts';
import { createCommunityOwnerPurgePort } from '../../services/api/src/community/purge.ts';
import { createPostgresCommunityStore } from '../../services/api/src/community/store-pg.ts';
import { USER_A, idem, makeHarness, publishPost } from './community-fixtures.mjs';
import { scriptedClock } from './favorites-history-fixtures.mjs';

/** 无法证明「已清干净」时的原因码（本片新增；语义：读数未知，不是「还有行没换」）。 */
const UNKNOWN_REASON = 'author-refs-remaining-unknown';
/** 已证实仍有行以原 author_id 关联本主体时的既有原因码。 */
const ROW_REASON = 'author-row-reference-not-replaced';

/** 造四个非社区域存储（本文件只关心社区模块，它们不缺席即可）。 */
function otherStores() {
  const clock = scriptedClock();
  return {
    favoritesStore: createMemoryFavoritesStore({ now: () => clock.ms }),
    historyStore: createMemoryHistoryStore({ now: () => clock.ms }),
    messagesStore: createMemoryMessagesStore({ now: () => clock.ms }),
    conversationsStore: createMemoryConversationStore(),
  };
}

/** 用给定的社区清理端口跑一次真实注销协调器，返回回执行 + 请求。 */
async function runDeletion(deletion, userId) {
  const request = deletion.requestDeletionFor(userId);
  await deletion.executeHandlers(String(request.id));
  const row = deletion
    .receipt(String(request.id))
    .handlers.find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.ok(row !== undefined, '回执必须含 community 行');
  return { request, row };
}

/**
 * 造一个"只会回报给定读数"的存储替身。
 *
 * ⚠️ `authorRefsReplaced: 1` 是**故意**的：旧实现在"缺读数"时要求
 * `authorRefsReplaced === 0` 才肯 blocked；只要换过 1 行（部分替换，正是软删行残留的真实
 * 形态），旧实现就会判 completed。这也让本文件的红灯证明"红的是残留 fail-open，不是别的"。
 */
function countsWith(overrides = {}) {
  return {
    records: 0,
    idempotency: 0,
    retained: 1,
    redacted: 0,
    hiddenMedia: 0,
    authorRefsReplaced: 1,
    ...overrides,
  };
}

/** 用固定读数构造端口（作者目录恒能生成合法注销引用，排除其它 blocked 来源）。 */
function fakePort(counts) {
  return createCommunityOwnerPurgePort({
    store: {
      async purgeOwnerData() {
        return counts;
      },
    },
    authors: {
      resolve: async () => null,
      anonymize: async () => ({ display_id: 'gy-anon-0123456789abcdef' }),
    },
  });
}

// ---------------------------------------------------------------------------
// A. 读数缺失 / 不可信 ⇒ blocked
// ---------------------------------------------------------------------------
test('A. 读数缺失或不可信 ⇒ 一律 blocked + author-refs-remaining-unknown（⛔ 不得回落旧判据）', async (t) => {
  // 每一种都必须是"证明不了已清干净"：缺字段、null、字符串、负数、非整数、非有限值、超安全整数。
  const cases = [
    ['存储不报告该字段', {}],
    ['undefined', { authorRefsRemaining: undefined }],
    ['null', { authorRefsRemaining: null }],
    ['字符串 "3"', { authorRefsRemaining: '3' }],
    ['负数 -1', { authorRefsRemaining: -1 }],
    ['非整数 1.5', { authorRefsRemaining: 1.5 }],
    ['NaN', { authorRefsRemaining: Number.NaN }],
    ['Infinity', { authorRefsRemaining: Number.POSITIVE_INFINITY }],
    ['-Infinity', { authorRefsRemaining: Number.NEGATIVE_INFINITY }],
    ['超出安全整数的 2^53', { authorRefsRemaining: 2 ** 53 }],
    ['非数类型的 true', { authorRefsRemaining: true }],
  ];
  for (const [label, override] of cases) {
    await t.test(label, async () => {
      const result = await fakePort(countsWith(override)).purgeOwnerData(USER_A.userId);
      assert.equal(
        result.blocked,
        1,
        `${label} ⇒ 无法证明已清干净，必须 blocked=1（实际 ${String(result.blocked)}，读数 ${JSON.stringify(result)}）`,
      );
      assert.deepEqual(
        [...result.blockedReasons],
        [UNKNOWN_REASON],
        `${label} ⇒ 原因码必须是「读数未知」，⛔ 不得回落旧判据（实际 ${JSON.stringify(result.blockedReasons)}）`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// B. 旧保底判据已删除（不是换马甲）
// ---------------------------------------------------------------------------
test('B. 旧保底判据已删除：authorRefsReplaced===0 且无保留行时，缺读数仍报 unknown（不是 row-reference）', async () => {
  // 旧实现在这个组合下会命中"防御性保底"并报 `author-row-reference-not-replaced`。
  // 新实现必须先回答"读数可不可信"：不可信 ⇒ UNKNOWN；⛔ 不许用"换了 0 行"推断"还有行没换"。
  const result = await fakePort(countsWith({
    authorRefsReplaced: 0,
    retained: 0,
    redacted: 0,
    authorRefsRemaining: undefined,
  })).purgeOwnerData(USER_A.userId);
  assert.equal(result.blocked, 1, '缺读数 ⇒ 无论换了 0 行还是 1 行，都不得判完成');
  assert.deepEqual([...result.blockedReasons], [UNKNOWN_REASON], '原因码只认「读数未知」');
  assert.equal(
    result.blockedReasons.includes(ROW_REASON),
    false,
    '旧判据来源的原因码不得再出现（它正是 fail-open 的来源）',
  );
});

// ---------------------------------------------------------------------------
// C. 真实注销协调器（P6 探针：存储不报告读数）
// ---------------------------------------------------------------------------
test('C. 真实注销协调器：存储不报告读数 ⇒ 社区回执 online_state=blocked（不是 completed）', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(800));
  // 清理照做，但把读数**从返回值里拿掉**：模拟审查探针 P6 的"替身不报告"。
  const silentStore = {
    deleteAllByOwner: (ownerId) => h.store.deleteAllByOwner(ownerId),
    async purgeOwnerData(ownerId, options) {
      const counts = await h.store.purgeOwnerData(ownerId, options);
      assert.equal(
        typeof counts.authorRefsRemaining,
        'number',
        '前置：真实内存实现本来就报告该读数（本用例只模拟"不报告"的替身）',
      );
      const { authorRefsRemaining: _omitted, ...rest } = counts;
      return rest;
    },
  };
  const observed = [];
  const innerPort = createCommunityOwnerPurgePort({ store: silentStore, authors: h.authors });
  const communityStore = {
    deleteAllByOwner: (ownerId) => innerPort.deleteAllByOwner(ownerId),
    async purgeOwnerData(ownerId) {
      const result = await innerPort.purgeOwnerData(ownerId);
      observed.push(result);
      return result;
    },
  };
  const deletion = createUserDataDeletion({ ...otherStores(), communityStore });
  const { request, row } = await runDeletion(deletion, USER_A.userId);

  assert.equal(observed.length, 1, '注销协调器应恰好调用一次社区清理');
  assert.equal(observed[0].blocked, 1, `缺读数 ⇒ 端口必须 blocked（实际 ${JSON.stringify(observed[0].blockedReasons)}）`);
  assert.deepEqual([...observed[0].blockedReasons], [UNKNOWN_REASON]);
  assert.equal(
    row.online_state,
    'blocked',
    `存储不报告读数时不得报 completed（实际 ${String(row.online_state)}）`,
  );
  assert.notEqual(row.online_state, 'completed', '「completed」与「无法证明已清干净」不能同时成立');
  assert.equal(row.error_code, 'POLICY_BLOCKED', 'blocked 行必须带安全错误码');
  // 行确实被清了（不是"没做"）：即使如此，**证明**缺席也不能冒充完成。
  assert.equal((await h.store.getPost(post.id)).author_id, null, '前置/旁证：清理本身已执行');

  const evidence = deletion.evidenceOf(String(request.id))[COMMUNITY_DELETION_MODULE];
  assert.match(String(evidence), /community:blocked:1/, `证据串必须记下 blocked（实际 ${String(evidence)}）`);
  assert.match(
    String(evidence),
    /community:blocked-reasons:author-refs-remaining-unknown/,
    `证据串必须带原因码（实际 ${String(evidence)}）`,
  );
});

// ---------------------------------------------------------------------------
// D. 正常路径
// ---------------------------------------------------------------------------
test('D. 正常读数 0 ⇒ completed（真实内存实现 + 替身两条都不得被新判据误伤）', async () => {
  // D1：替身如实报告 0 ⇒ 无 blocked。
  const clean = await fakePort(countsWith({ authorRefsRemaining: 0 })).purgeOwnerData(USER_A.userId);
  assert.equal(clean.blocked, 0, '剩余 0 ⇒ 不得 blocked');
  assert.deepEqual([...clean.blockedReasons], [], '剩余 0 ⇒ 无原因码');

  // D2：空主体（重放注销）也必须是 completed —— 0 行剩余是可信的 0，不是"未知"。
  const idle = await fakePort({
    records: 0,
    idempotency: 0,
    retained: 0,
    redacted: 0,
    hiddenMedia: 0,
    authorRefsReplaced: 0,
    authorRefsRemaining: 0,
  }).purgeOwnerData(USER_A.userId);
  assert.equal(idle.blocked, 0, '空主体（已在上一轮清干净）⇒ completed');
  assert.deepEqual([...idle.blockedReasons], []);

  // D3：真实内存实现 + 真实注销协调器 ⇒ 读数 0，回执 completed（端到端反向控制）。
  const h = makeHarness();
  await publishPost(h.service, USER_A, {}, idem(810));
  const observed = [];
  const innerPort = createCommunityOwnerPurgePort({ store: h.store, authors: h.authors });
  const communityStore = {
    deleteAllByOwner: (ownerId) => innerPort.deleteAllByOwner(ownerId),
    async purgeOwnerData(ownerId) {
      const result = await innerPort.purgeOwnerData(ownerId);
      observed.push(result);
      return result;
    },
  };
  const deletion = createUserDataDeletion({ ...otherStores(), communityStore });
  const { row } = await runDeletion(deletion, USER_A.userId);
  assert.equal(observed[0].authorRefsRemaining, 0, `真实内存实现必须报告 0（实际 ${String(observed[0].authorRefsRemaining)}）`);
  assert.equal(observed[0].blocked, 0);
  assert.equal(row.online_state, 'completed', '正常路径必须仍是 completed（新判据不得把正常路径弄成 blocked）');
  assert.equal(row.error_code, null);
});

test('E. 正常读数 >0 ⇒ blocked + author-row-reference-not-replaced（既有语义保持不变）', async () => {
  const result = await fakePort(countsWith({ authorRefsRemaining: 3 })).purgeOwnerData(USER_A.userId);
  assert.equal(result.blocked, 1, '仍剩 3 行 ⇒ must blocked');
  assert.deepEqual([...result.blockedReasons], [ROW_REASON], '有真实残留 ⇒ 仍用「还有行没换」这个原因码');
});

// ---------------------------------------------------------------------------
// F. PG 实现（store-pg）：测量不可读 ⇒ unknown 哨兵，⛔ 不得当成 0
// ---------------------------------------------------------------------------
/**
 * 只回答"剩余计数"那条查询的假池：其余语句一律返回空行。
 *
 * 为什么不用 PGlite：PGlite 的 `count(*)::int` 恒返回合法整数，构造不出"驱动层读不到计数"
 * 这一分支；而**这个分支正是留 fail-open 的地方**（旧实现 `Number(row.remaining ?? 0)` 会把
 * "没读到"折成 0 ⇒ 端口判 completed）。假池只替身驱动返回形状，不改被测代码。
 */
function scriptedCountPool(remainingRows) {
  const connection = {
    async query(text) {
      if (String(text).includes('count(*)::int AS remaining')) {
        return { rows: remainingRows };
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    async query() {
      return { rows: [] };
    },
    async connect() {
      return connection;
    },
  };
}

test('F. PG 实现：计数不可读 ⇒ 报 unknown 哨兵（⛔ 不得折成 0）；正常 0 行仍如实 0', async (t) => {
  // R32（迁移 0032）后剩余读数有**三个**分支：帖 / 评 / 举报。少任何一个分支都等于
  // "还有一类账户关联没被看见" ⇒ 必须 unknown（fail-closed），⛔ 不得把"少一行"当 0。
  const unreadable = [
    ['一行计数都没返回（[]）', []],
    ['只返回 1/3（缺两张表的 count）', [{ remaining: 0 }]],
    ['只返回 2/3（缺一张表的 count）', [{ remaining: 0 }, { remaining: 0 }]],
    ['计数为 null', [{ remaining: null }, { remaining: 0 }, { remaining: 0 }]],
    ['计数是字符串 "3"（驱动层未转成数字）', [{ remaining: '3' }, { remaining: 0 }, { remaining: 0 }]],
    ['计数是 1.5', [{ remaining: 1.5 }, { remaining: 0 }, { remaining: 0 }]],
    ['计数是 -1', [{ remaining: -1 }, { remaining: 0 }, { remaining: 0 }]],
  ];
  for (const [label, rows] of unreadable) {
    await t.test(label, async () => {
      const store = createPostgresCommunityStore({ pool: scriptedCountPool(rows) });
      const counts = await store.purgeOwnerData(USER_A.userId, { anonymizedAuthorRef: 'gy-anon-0123456789abcdef' });
      assert.equal(
        Number.isNaN(counts.authorRefsRemaining),
        true,
        `${label} ⇒ 必须报 unknown 哨兵（NaN），⛔ 不得折成 0（实际 ${String(counts.authorRefsRemaining)}）`,
      );
      // 端口拿到的就是这个读数 ⇒ 必须 blocked + UNKNOWN（两侧同一口径）。
      const port = createCommunityOwnerPurgePort({
        store,
        authors: {
          resolve: async () => null,
          anonymize: async () => ({ display_id: 'gy-anon-0123456789abcdef' }),
        },
      });
      const result = await port.purgeOwnerData(USER_A.userId);
      assert.equal(result.blocked, 1, `${label} ⇒ 端口必须 blocked`);
      assert.deepEqual([...result.blockedReasons], [UNKNOWN_REASON]);
    });
  }

  await t.test('正常：三表都报 0 ⇒ 0，且端口 completed', async () => {
    const store = createPostgresCommunityStore({
      pool: scriptedCountPool([{ remaining: 0 }, { remaining: 0 }, { remaining: 0 }]),
    });
    const counts = await store.purgeOwnerData(USER_A.userId, { anonymizedAuthorRef: 'gy-anon-0123456789abcdef' });
    assert.equal(counts.authorRefsRemaining, 0, '三表都报 0 ⇒ 读数如实为 0');
    const port = createCommunityOwnerPurgePort({
      store,
      authors: {
        resolve: async () => null,
        anonymize: async () => ({ display_id: 'gy-anon-0123456789abcdef' }),
      },
    });
    const result = await port.purgeOwnerData(USER_A.userId);
    assert.equal(result.blocked, 0, '正常 0 ⇒ 不得 blocked');
    assert.deepEqual([...result.blockedReasons], []);
  });

  await t.test('正常：一表剩 1 行 ⇒ 1，端口 blocked + row-reference', async () => {
    const store = createPostgresCommunityStore({
      pool: scriptedCountPool([{ remaining: 1 }, { remaining: 0 }, { remaining: 0 }]),
    });
    const counts = await store.purgeOwnerData(USER_A.userId, { anonymizedAuthorRef: 'gy-anon-0123456789abcdef' });
    assert.equal(counts.authorRefsRemaining, 1, '一表 1 行 ⇒ 读数如实为 1');
    const port = createCommunityOwnerPurgePort({
      store,
      authors: {
        resolve: async () => null,
        anonymize: async () => ({ display_id: 'gy-anon-0123456789abcdef' }),
      },
    });
    const result = await port.purgeOwnerData(USER_A.userId);
    assert.equal(result.blocked, 1);
    assert.deepEqual([...result.blockedReasons], [ROW_REASON]);
  });

  // R32 新增：**只有举报**那一个分支剩 1 行 ⇒ 读数必须把它算进来（这正是 #483 之后漏掉的那类
  // 残留：帖评都干净、举报还指着账户）。上一个"一表剩 1 行"用的是三分支里的第一个（帖）；
  // 这里专门把 1 放在**第三个**（举报）分支，证明求和不是"只取前两行"。
  await t.test('正常：只有举报分支剩 1 行 ⇒ 1（读数必须把第三个分支算进去）', async () => {
    const store = createPostgresCommunityStore({
      pool: scriptedCountPool([{ remaining: 0 }, { remaining: 0 }, { remaining: 1 }]),
    });
    const counts = await store.purgeOwnerData(USER_A.userId, { anonymizedAuthorRef: 'gy-anon-0123456789abcdef' });
    assert.equal(counts.authorRefsRemaining, 1, '举报分支 1 行 ⇒ 读数如实为 1（⛔ 不得只加前两行）');
    const port = createCommunityOwnerPurgePort({
      store,
      authors: {
        resolve: async () => null,
        anonymize: async () => ({ display_id: 'gy-anon-0123456789abcdef' }),
      },
    });
    const result = await port.purgeOwnerData(USER_A.userId);
    assert.equal(result.blocked, 1, '只剩举报残留 ⇒ 必须 blocked');
    assert.deepEqual([...result.blockedReasons], [ROW_REASON]);
  });
});
