/**
 * A 档回归钉 · 社区「重审驳回」的通知去重（GY-I15 / GY-I17 通知面）。
 *
 * ## 本文件钉住的那一条事实（2026-10，基线 `31291afb`）
 *
 * 社区帖走 `reReviewContent`（`services/api/src/community/service.ts:1735`）被驳回时，
 * 作者收件箱里**只**新增一条审核结果消息，去重键精确为
 * `community:moderation_result:post:<id>:r<rev>:rejected`；
 * 并且**不会**出现任何以 `community:takedown:` 开头的键。
 *
 * ## 为什么必须是「恰好 1 条」，而不是「至少 1 条」
 *
 * 装配层给「交给后台的社区帖子端口」套了下架观察器（`services/api/src/app.ts:1276-1277`）：
 *
 *     const communityPostPortForAdmin =
 *       adminInjection?.communityStore ?? withTakedownObserver(communityStore, { events: communityEvents });
 *
 * 而社区服务拿到的是**未包装**的那份 store —— store 在 `services/api/src/app.ts:862` 建、
 * 在 `services/api/src/app.ts:1257` 注入给 `createCommunityService`。
 *
 * `withTakedownObserver`（`services/api/src/community/takedown.ts:58`）只要看到
 * 「CAS 成功 + 补丁 `visibility:'hidden'` + 结果 `visibility:'hidden'`」（同文件 `:77`）就补发一条
 * `takedown` 事件（事件键见 `services/api/src/community/events.ts:112-118`，takedown 分支取
 * `:<reason>`，缺省 reason 是 `admin_hide`）。
 *
 * 重审驳回也把帖子写成 `visibility:'hidden'`（`services/api/src/community/service.ts:1779`），
 * 但它走的是**未包装** store ⇒ 观察器看不见 ⇒ 不会补发 `takedown`。
 *
 * 一旦哪天有人把观察器套到社区服务那份 store 上（很自然的一次「顺手统一装配」），这条路径就会
 * 多出第二条消息 `community:takedown:post:<id>:r<rev>:admin_hide`：作者会同时收到「被下架」与
 * 「未通过审核」两份通知——同一次处置、两条消息。本文件把这个「多一条」变成红灯，
 * 失败信息直接把多出来的键打出来。
 *
 * ## 负控制（**不在本文件里**，跑法与读数见提交信息）
 *
 * 在同一份 memory store 外套上 `withTakedownObserver` 后重跑本路径 ⇒ 读数从 **1 条**变 **2 条**
 * （多出 `community:takedown:post:<id>:r1:admin_hide`），本文件的断言随之变红。
 * 跑完即撤掉，文件保持原状绿。
 *
 * ## 声明
 *
 * 模型端口是**合成替身**（`passingPort`），不发起任何真实模型/付费调用；`reReviewContent` 目前
 * **没有 HTTP 路由**（全仓 `git grep reReviewContent` 只命中定义、文档与测试），所以这里按服务层
 * 调用，不臆造请求路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES } from '../../packages/moderation/index.mjs';
import { makeExtraRule } from '../moderation/_fixtures.mjs';
import {
  API,
  USER_A,
  idem,
  makeGate,
  makeWiredHarness,
  passingPort,
  postInput,
} from './community-moderation-fixtures.mjs';

const TAKEDOWN_PREFIX = 'community:takedown:';

/** 收件箱投影成去重键并**排序**（同刻消息的落库次序不比）。 */
function keysOf(rows) {
  return rows.map((row) => row.event_key).sort();
}

function takedownKeysOf(rows) {
  return keysOf(rows).filter((key) => key.startsWith(TAKEDOWN_PREFIX));
}

/**
 * 建两套**真实 `buildApp`** 装配，共享同一份社区 store 与同一份消息 store。
 *
 * 为什么非得两套：`reReviewContent` 只有在「规则版本变了」时才真重审
 * （`services/api/src/community/service.ts:1763` 的 `assessment.stale` 早退），而 gate 在
 * `buildApp` 里只建一次（`services/api/src/app.ts:1257` 的 `gate` 入参）。第二套装配只换 gate、
 * 沿用第一套的 `store` / `messages`（`makeWiredHarness` 的 `store` / `messages` 复用口），
 * 于是「同一条社区链路、同一份数据」而不是两份副本。
 */
function makeUpgradedHarness(base, gateOptions) {
  return makeWiredHarness({
    store: base.store,
    messages: base.messages,
    gate: makeGate(gateOptions),
    ports: { tms: passingPort() },
  });
}

test('钉①：reReviewContent 驳回 ⇒ 作者收件箱**恰好**新增 1 条 `...:r<rev>:rejected`，键精确相等', async () => {
  // 装配 A：出厂规则集，把帖子建成 published / approved。
  const h1 = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await h1.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });

  const approvedKey = `community:moderation_result:post:${post.id}:r1:approved`;
  const rejectedKey = `community:moderation_result:post:${post.id}:r1:rejected`;
  const before = await h1.messages.listMessagesByOwner(USER_A.userId);
  assert.deepEqual(keysOf(before), [approvedKey], '改前口径：作者收件箱里只有自己投稿的审核通过这一条');

  // 装配 B：同一份 store / 同一份消息 store，规则集升级（多一条命中「稗草」的 block 规则）。
  const h2 = makeUpgradedHarness(h1, { rules: [...RULES, makeExtraRule()] });
  const report = await h2.service.reReviewContent(USER_A, { type: 'post', id: post.id, revision: 1 });
  assert.equal(report.re_reviewed, true, '规则版本变了 ⇒ 必须真重审（早退说明装配口径变了）');
  assert.equal(report.decision, 'rejected');
  assert.equal(report.visibility, 'hidden');

  const after = await h1.messages.listMessagesByOwner(USER_A.userId);
  assert.equal(
    after.length,
    before.length + 1,
    `驳回后必须**恰好**新增 1 条消息：改前 ${before.length} 条、改后 ${after.length} 条` +
      `（新增 ${after.length - before.length} 条）。实际键集合 = ${JSON.stringify(keysOf(after))}；` +
      `多出来的键通常是 ${TAKEDOWN_PREFIX}…（下架观察器被套到了社区服务那份 store 上）。`,
  );
  assert.deepEqual(
    keysOf(after),
    [approvedKey, rejectedKey].sort(),
    '键集合必须精确等于「审核通过 + 重审驳回」两条，不得有第三条',
  );

  // 单条消息的形状（接收者 / 跳转目标 / 未读 / 类型）。
  const rejected = after.filter((row) => row.event_key === rejectedKey);
  assert.equal(rejected.length, 1, '同一条键只允许一行（消息层同键幂等：迁移 0019 的 UNIQUE (owner_id, event_key)）');
  const [message] = rejected;
  assert.equal(message.owner_id, USER_A.userId, '收件人必须是帖子作者');
  assert.equal(message.type, 'moderation', '驳回是平台处置结论 ⇒ moderation，不是 takedown/system');
  assert.deepEqual(message.target_ref, { type: 'post', id: post.id, revision: 1 }, '跳转目标是被驳回的那一版');
  assert.equal(message.read_at, null, '新消息必须未读');
});

test('钉②：重审驳回这条路径上**不存在**任何 `community:takedown:` 键（后台下架才有）', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const reviewed = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(2) });
  const upgraded = makeUpgradedHarness(h, { rules: [...RULES, makeExtraRule()] });
  await upgraded.service.reReviewContent(USER_A, { type: 'post', id: reviewed.id, revision: 1 });

  const afterReview = await h.messages.listMessagesByOwner(USER_A.userId);
  assert.deepEqual(
    takedownKeysOf(afterReview),
    [],
    `重审驳回不得产生下架键：重审走的是未包装 store（app.ts:1257 注入 ` +
      `app.ts:862 建的那份），下架观察器只套在交给后台的端口上（app.ts:1276-1277）。` +
      `实际命中 ${JSON.stringify(takedownKeysOf(afterReview))}`,
  );

  // 反证：**同一条 store、同一个事件端口**上，后台下架确实会产生 takedown 键
  // ——证明「没有 takedown 键」不是观察器失灵，而是重审链路根本不在它上游。
  const admin = await h.adminSession();
  const hidden = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(3) });
  const response = await h.inject('POST', `${API}/admin/posts/${hidden.id}/hide`, {
    token: admin.token,
    headers: { 'idempotency-key': 'gy-r59-notify-pins-hide-0001', 'if-match': '"1"' },
    payload: { reason: '内容不符合社区规范' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));

  const afterHide = await h.messages.listMessagesByOwner(USER_A.userId);
  assert.deepEqual(
    takedownKeysOf(afterHide),
    [`community:takedown:post:${hidden.id}:r1:admin_hide`],
    '后台下架必须产生恰好一条下架键（观察器有效性的同源对照）',
  );
  // 被重审驳回的那条仍然没有下架键：两种处置各自一条键，互不冒充。
  assert.deepEqual(
    takedownKeysOf(afterHide).filter((key) => key.includes(reviewed.id)),
    [],
    '重审驳回的那条帖子永远不该出现下架键',
  );
});
