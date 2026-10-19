/**
 * GY-I14（#14）⇄ GY-I15（#15）联动接线 · **后台 `hidePost` 下架联动**与**跨域同源**（`Refs #14`, `Refs #15`）。
 *
 * 覆盖（派单 §2 第 3、4 组）：
 *   G3-a `hidePost` 生效后**驱动审核域下架**：`invalidated_cache_keys` 口径（整链缓存失效）、
 *        版本口径与被下架的那一版一致（不留事件字段）、台账 withdrawn 计数；
 *   G3-b 该版本**永久不可复活**：审核域 `publish` 以 `OBJECT_UNAVAILABLE` 拒绝（可重复，幂等）；
 *   G3-c 列表/详情/引用一致：公开面（他人 feed/详情/评论列表）一律消失，作者视角显式 `hidden`，
 *        旧 ETag 不得写回公开；
 *   G4-a **跨域同源（正控制）**：审核域的下架/读取重查作用在**社区真实内容行**上
 *        （`authority_origin === 'community_store'`）；
 *   G4-b **跨域同源（负控制）**：把权威端口换成替身副本后，审核域下架**不改动**社区真实行
 *        ⇒ 证明上面的断言确实在测"同源"，而不是"任何实现都会通过"。
 *
 * 声明：模型端口是**合成替身**（`provider.synthetic === true`）；不发起任何真实模型/付费调用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubstituteContentAuthority } from '../../services/api/src/moderation/visibility.ts';
import { idem } from './community-fixtures.mjs';
import {
  API,
  CLEAN_BODY,
  USER_A,
  USER_B,
  expectApiError,
  makeWiredHarness,
  passingPort,
  postInput,
} from './community-moderation-fixtures.mjs';

/** 合成管理员主体（审核域侧；身份由服务端权威注入，客户端不可自述）。 */
const MODERATION_ADMIN = Object.freeze({
  userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  role: 'admin',
  authEpoch: 1,
});

/** 审核域读缓存键口径（`moderation/visibility.ts` 的 `cacheKey`）。 */
function cacheKey(type, id, revision) {
  return `${type}|${id}|${revision}`;
}

async function publishPost(h, over = {}, key = idem(1)) {
  return h.service.createPost(USER_A, postInput(over), { idempotencyKey: key });
}

async function hideViaAdminRoute(h, id, revision = '"1"', key = 'gy-i14i15-hide-0001') {
  const admin = await h.adminSession();
  return h.inject('POST', `${API}/admin/posts/${id}/hide`, {
    token: admin.token,
    headers: { 'idempotency-key': key, 'if-match': revision },
    payload: { reason: '内容不符合社区规范' },
  });
}

// ---------------------------------------------------------------------------
// G3-a hidePost ⇒ 审核域缓存整链失效（invalidated_cache_keys 口径）
// ---------------------------------------------------------------------------

test('G3a. 后台 hidePost 生效后驱动审核域下架：缓存整链失效（invalidated_cache_keys）+ 台账 withdrawn', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await publishPost(h);

  // 先让审核域**真的**把该版本读进缓存（否则"失效了 0 个键"是没有意义的断言）。
  const before = await h.link.readView({
    actor: MODERATION_ADMIN,
    target_ref: { type: 'post', id: post.id, revision: 1 },
  });
  assert.equal(before.visible, true, '前提：下架前审核域读取面可见');
  assert.equal(h.moderation.counts().cache_entries, 1, '前提：审核域读缓存里已有该版本条目');

  const hidden = await hideViaAdminRoute(h, post.id);
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.deepEqual(hidden.body.data, { accepted: true });

  // 联动确实发生了一次审核域下架，入参取自**真实后台会话**与**处置前**的 revision。
  assert.equal(h.calls.withdraw.length, 1, '后台下架必须驱动一次审核域下架');
  const withdrawInput = h.calls.withdraw[0].input;
  assert.equal(withdrawInput.actor.role, 'admin');
  assert.equal(withdrawInput.actor.userId.length > 0, true, '主体必须来自真实后台会话（不得为空）');
  assert.deepEqual(withdrawInput.target_ref, { type: 'post', id: post.id, revision: 1 },
    '下架目标版本必须是**被公开过/被缓存过**的那一版（后台隐藏会把 revision +1）');
  assert.equal(withdrawInput.reason_code, 'admin_hide');

  // **缓存失效口径**：被失效的键就是该目标整链（此处该版本恰好是唯一被缓存过的版本）。
  const withdrawResult = h.calls.withdraw[0].result;
  assert.equal(withdrawResult.withdrawn, true);
  assert.equal(withdrawResult.visibility, 'hidden');
  assert.deepEqual(withdrawResult.invalidated_cache_keys, [cacheKey('post', post.id, 1)]);
  assert.equal(h.moderation.counts().cache_entries, 0, '下架必须让审核域读缓存整链失效');
  assert.equal(h.moderation.counts().withdrawn, 1, '台账必须记下 withdrawn 标记');
  // 下架**不再产出事件字段**：那类事件零订阅方（下架对外唯一信号就是被失效的缓存键，
  // 而缓存失效本来就是同一次 `withdraw()` 内同步完成的，不需要订阅方）。
  assert.equal('event' in withdrawResult, false, '下架返回值不得再带零订阅方的事件字段');
  // 换成更强的整串断言：整个下架返回值（不只是某个子对象）都不得夹带正文。
  assert.equal(JSON.stringify(withdrawResult).includes(CLEAN_BODY), false, '下架返回值不得夹带正文');

  // **版本口径同一套**（诊断 R6）：审核域下架目标、缓存失效键、以及社区下架消息，
  // 必须全部指向**同一版**——即被公开发布/被缓存的那一版（＝处置前 revision），
  // 任何一处差 1 都会让失效键打错版本、恰好漏掉真正被缓存的那一版。
  const invalidatedRevisions = withdrawResult.invalidated_cache_keys.map((key) => key.split('|')[2]);
  assert.deepEqual(invalidatedRevisions, ['1'], '失效键里的版本必须是被缓存过的那一版');
  assert.equal(Number(invalidatedRevisions[0]), withdrawInput.target_ref.revision,
    '失效键版本与审核域下架目标版本必须一致');

  // 社区真实内容行确实已被后台隐藏（同源存储）。
  const row = await h.store.getPost(post.id);
  assert.equal(row.visibility, 'hidden');
  assert.equal(row.revision, 2, '后台隐藏推进 revision（可见性写入的权威仍在社区 CAS）');
});

// ---------------------------------------------------------------------------
// G3-b 该版本永久不可复活
// ---------------------------------------------------------------------------

test('G3b. 下架后该版本永久不可复活：审核域 publish 一律 OBJECT_UNAVAILABLE（可重复、幂等）', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await publishPost(h);
  const hidden = await hideViaAdminRoute(h, post.id, '"1"', 'gy-i14i15-hide-0002');
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));

  const content = {
    target_ref: { type: 'post', id: post.id, revision: 1 },
    text: `${postInput().title}\n${CLEAN_BODY}`,
    media: [],
  };
  // 下架标记是**永久**的：连续两次以"完全相同的、本可发布的"内容尝试发布都被拒绝。
  for (const attempt of [1, 2]) {
    await expectApiError(
      () => h.moderation.publish({ actor: MODERATION_ADMIN, content }),
      'OBJECT_UNAVAILABLE',
      409,
    );
    assert.equal(h.moderation.counts().withdrawn, 1, `第 ${attempt} 次尝试后 withdrawn 标记仍在`);
  }
  // 读取面同样不因缓存/旧链接复活。
  const after = await h.link.readView({
    actor: MODERATION_ADMIN,
    target_ref: { type: 'post', id: post.id, revision: 1 },
  });
  assert.equal(after.visible, false);
  assert.equal(after.visibility, 'hidden');
  assert.deepEqual(after.reason_codes, ['CONTENT_HIDDEN']);
  // 社区行仍是 hidden（没有任何"写回公开"的路径被触发）。
  assert.equal((await h.store.getPost(post.id)).visibility, 'hidden');
});

// ---------------------------------------------------------------------------
// G3-c 列表/详情/引用一致
// ---------------------------------------------------------------------------

test('G3c. 下架后列表/详情/引用一致：公开面消失、作者视角显式 hidden、旧 ETag 不得写回公开', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await publishPost(h);
  const comment = await h.service.createComment(
    USER_B,
    post.id,
    { body: '按标签说明处理，注意轮换。' },
    { idempotencyKey: idem(2), ifMatch: '"1"' },
  );
  assert.equal(comment.revision, 1);
  assert.equal((await h.service.listComments(USER_A, post.id)).items.length, 1);

  const hidden = await hideViaAdminRoute(h, post.id, '"1"', 'gy-i14i15-hide-0003');
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));

  // 公开面（他人）：列表空、详情 404、评论列表 404（引用该帖的读面同样不得泄露）。
  assert.deepEqual(await h.service.listPosts(USER_B), { items: [], next_cursor: null });
  await expectApiError(() => h.service.getPost(USER_B, post.id), 'NOT_FOUND', 404);
  await expectApiError(() => h.service.listComments(USER_B, post.id), 'NOT_FOUND', 404);

  // 作者视角：仍可读自己的已下架版本，但必须**显式标注 hidden**（透明，不一处显示一处隐藏）。
  const mine = await h.service.getPost(USER_A, post.id);
  assert.equal(mine.visibility, 'hidden');
  assert.notEqual(mine.visibility, 'published');
  const mineFeed = await h.service.listPosts(USER_A, { mine: true });
  assert.equal(mineFeed.items.length, 1);
  assert.equal(mineFeed.items[0].visibility, 'hidden');
  assert.deepEqual(await h.service.listPosts(USER_A), { items: [], next_cursor: null },
    '公开 feed 对作者同样不得展示已下架内容');

  // 旧 ETag（"1"）不得用来把隐藏内容写回公开。
  await expectApiError(
    () => h.service.editPost(USER_A, post.id, postInput({ body: '想把隐藏内容写回公开' }), { idempotencyKey: idem(3), ifMatch: '"1"' }),
    'REVISION_CONFLICT',
    409,
  );
  assert.equal((await h.store.getPost(post.id)).visibility, 'hidden');
});

// ---------------------------------------------------------------------------
// G4-a 跨域同源（正控制）
// ---------------------------------------------------------------------------

test('G4a. 跨域同源：审核域下架/读取重查作用在社区真实内容行上（authority_origin = community_store）', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await publishPost(h);

  // 权威来源标签：**同源社区权威**（不是替身副本，也不是 real 未接线）。
  assert.equal(h.moderation.counts().authority_origin, 'community_store');
  assert.equal(h.link.counts().authority_origin, 'community_store');

  // 直接驱动**审核域自己的**下架（不经后台）：写入必须落在社区那一份内容行上。
  const outcome = await h.moderation.withdraw({
    actor: MODERATION_ADMIN,
    target_ref: { type: 'post', id: post.id, revision: 1 },
    reason_code: 'compliance_takedown',
  });
  assert.equal(outcome.withdrawn, true);
  assert.equal(outcome.visibility, 'hidden');

  const row = await h.store.getPost(post.id);
  assert.equal(row.visibility, 'hidden', '审核域下架必须改写社区真实内容行（不是第二份副本）');
  assert.equal(row.revision, 1, '审核域下架不推进 revision（版本推进属内容写路径）');
  assert.equal(row.author_id, USER_A.userId);

  // 读取重查也作用在同一行上：审核域读到的就是社区真实状态。
  const view = await h.moderation.readView({
    actor: MODERATION_ADMIN,
    target_ref: { type: 'post', id: post.id, revision: 1 },
  });
  assert.equal(view.visible, false);
  assert.equal(view.visibility, 'hidden');
  assert.deepEqual(view.reason_codes, ['CONTENT_HIDDEN']);

  // 社区读取面随之一致：他人不可见、作者显式 hidden。
  assert.deepEqual(await h.service.listPosts(USER_B), { items: [], next_cursor: null });
  await expectApiError(() => h.service.getPost(USER_B, post.id), 'NOT_FOUND', 404);
  assert.equal((await h.service.getPost(USER_A, post.id)).visibility, 'hidden');
});

// ---------------------------------------------------------------------------
// G4-b 跨域同源（负控制）：换成替身副本后，社区真实行不受影响
// ---------------------------------------------------------------------------

test('G4b. 【负控制】权威端口换成替身副本 ⇒ 审核域下架不改动社区真实行（证明 G4a 测的是同源）', async () => {
  // 先由**同源装配**把内容写进社区 store（发布闸门已接进社区写路径：发布必须经同源权威落行，
  // 见 G6c/G1d）。随后用**共用同一份 store** 的另一套装配把权威端口换成替身副本 ——
  // 本负控制要证明的是"下架只作用于权威端口指向的那份数据"，与发布路径无关。
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await publishPost(h);

  const substitute = createSubstituteContentAuthority();
  const detached = makeWiredHarness({ store: h.store, ports: { tms: passingPort() }, authority: substitute });

  // 替身副本自行登记同一目标（它不是社区存储，只是另一份内存表）。
  substitute.seed(
    { type: 'post', id: post.id, revision: 1 },
    { visibility: 'published', author_state: 'active', source_kind: 'simulation', owner_id: USER_A.userId },
  );
  assert.equal(
    detached.moderation.counts().authority_origin,
    'substitute',
    '前提：本用例的权威端口是替身副本',
  );
  assert.equal(detached.store, h.store, '前提：两套装配共用**同一份**社区 store（否则"不受影响"没有意义）');

  const outcome = await detached.moderation.withdraw({
    actor: MODERATION_ADMIN,
    target_ref: { type: 'post', id: post.id, revision: 1 },
    reason_code: 'compliance_takedown',
  });
  assert.equal(outcome.withdrawn, true, '替身副本上"下架成功"——正是非同源时的假象');

  // **社区真实内容行完全不受影响**：仍公开可见（这就是必须接线到社区 store 的理由）。
  const row = await detached.store.getPost(post.id);
  assert.equal(row.visibility, 'published');
  assert.equal(row.revision, 1);
  assert.equal((await detached.service.listPosts(USER_B)).items.length, 1, '社区读取面仍把它当作公开内容');
  assert.equal((await detached.service.getPost(USER_B, post.id)).visibility, 'published');
});

// ---------------------------------------------------------------------------
// G3-d 审核域**端口形状不可读**（未接线/不合约）⇒ 后台联动失败的分类必须诚实
// ---------------------------------------------------------------------------

/**
 * 只把 `withdraw` 换成"形状不可读"（返回非对象）：其余端口**原样委托**真实实现
 * （判定、台账、社区真实行都不受影响）。用于驱动
 * `services/api/src/community/moderation-link.ts:367` 的 `shapeUnavailable('下架结论')`
 * —— 即"审核域端口未接线/不合约"在**真实链路**上的等价形态。
 */
function unreadableWithdrawPort(moderation) {
  return {
    get execution_mode() {
      return moderation.execution_mode;
    },
    submitScreening: (input) => moderation.submitScreening(input),
    publish: (input) => moderation.publish(input),
    withdraw: () => null,
    readView: (input) => moderation.readView(input),
    tasks: (targetRef) => moderation.tasks(targetRef),
    counts: () => moderation.counts(),
  };
}

test('G3d. 审核域下架端口形状不可读 ⇒ 后台联动如实 503 且 retryable=false（不得劝客户端重试）', async () => {
  const h = makeWiredHarness({
    ports: { tms: passingPort() },
    moderationPortWrapper: unreadableWithdrawPort,
  });
  const post = await publishPost(h);
  const hidden = await hideViaAdminRoute(h, post.id, '"1"', 'gy-i14i15-hide-g3d');
  assert.equal(hidden.status, 503, JSON.stringify(hidden.body));
  assert.equal(hidden.body.error.code, 'PROVIDER_UNAVAILABLE');
  // 形状不可读＝能力未接线/不合约 ⇒ 需运维排查端口，同一请求稍后重试不会自行成功 ⇒ 必须为 false。
  // 口径原文见 services/api/src/errors.ts 的 ApiError 注释。
  assert.equal(
    hidden.body.error.retryable,
    false,
    '审核域端口形状不可读 ⇒ retryable 必须为 false（不得把"未接线/不合约"说成瞬时故障）',
  );
  // 下架本身**已生效**：联动失败不得回滚可见性，也不得谎报"没下架"。
  assert.equal((await h.store.getPost(post.id)).visibility, 'hidden');
  assert.deepEqual(await h.service.listPosts(USER_B), { items: [], next_cursor: null });
});
