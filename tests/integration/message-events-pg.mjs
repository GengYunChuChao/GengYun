// GY-I17（#17）· **社区事件 → 消息域** 的真 PostgreSQL 17.11 投递／恢复证据
//
// 为什么需要这一条独立的真库臂（本片要补的缺口）：
//   `services/api/src/community/events.ts`（`createMessagesCommunityEventsPort` / `communityEventKey` /
//   `communityEventMessageType`）与「社区服务在评论/点赞/审核结论处调用它」这两件事，此前**只有单元层证据**：
//   `tests/unit/community-message-notifications.test.mjs`（N1..N8）与 `community-http.test.mjs` 都用
//   **内存**消息 store，`tests/integration/messages-pg.mjs` 则**手工**调 `messagesService.appendMessage`
//   （不经过社区域），`tests/integration/community-pg.mjs` 只证明社区内容真落库、**不看**消息域。
//   ⇒ 「社区事件真的能经 `appendMessage` 落到 `public.messages`，且靠真库唯一键去重、失败不拖垮内容写入、
//   进程内状态清空后仍能读回未读/已读」这条链路，在真库上从未被跑过。本脚本只补这一条。
//
// 运行（本机隔离集群，仅回环；库名硬钉，要求**空库**）：
//   createdb -h 127.0.0.1 -p <port> gengyun_message_events_test
//   node tests/integration/message-events-pg.mjs postgres://postgres@127.0.0.1:<port>/gengyun_message_events_test
//
// 覆盖的读数（与派单「四件事」逐条对齐）：
//   [M] 前提：空库 ⇒ `applyMigrations(discoverMigrations())` 全链自举（**不重复** messages-pg 的
//       0019 UP/ROLLBACK/REPLAY 三连，那是它那片的事）⇒ `public.messages` 与
//       `messages_owner_event_key` 唯一约束必须在岗。
//   [W] **落库**：三类社区事件各走**社区服务的真实写路径**（发帖 → 审核结论 / 他人评论 / 他人点赞），
//       不是手工构造 `appendMessage` ⇒ 真库一行一条；八列逐列核对（`owner_id`/`type`/`target_ref`/
//       `read_at`/`created_at`/`revision`/`event_key`）；`type` 与 `communityEventMessageType` 逐字相等、
//       `event_key` 与 `communityEventKey` 逐字相等、目标引用是**契约 `TargetRef`** 三字段。
//       再读 HTTP 面：`GET /messages` 只出契约七字段（`event_key`/`owner_id` 不外泄）。
//   [D] **幂等/去重**：同一 `communityEventKey` 重复投递 ⇒ 不产生第二行，且既有行的 `id`/`created_at`/
//       `read_at` 逐字不变（不重置读状态）。两条独立读数：① 端到端「取消赞→再赞」再次调度同一事件；
//       ② 直接对**真库 store** 用同一 `(owner_id, event_key)` 再写一次 ⇒ `duplicate`（裁决者是唯一约束，
//       不是应用层先查后写）。
//   [F] **失败隔离 + 失败可观测**：在 `public.messages` 上临时加一条 `CHECK (type <> 'like')` 约束把
//       消息落库真打断（数据库侧原始错误 `23514` check_violation），然后：
//       ① 他人点赞**内容写入照常成功**（`community_likes` 真库一行）——通知失败不拖垮权威结果；
//       ② 端口回传 `delivered:false` + `reason='PROVIDER_UNAVAILABLE'`（**可观测**）。注意：`store-pg.ts`
//       把驱动错误**折叠**成契约闭集错误码（`57014`/`55P03` ⇒ `PROVIDER_TIMEOUT`，其余 ⇒
//       `PROVIDER_UNAVAILABLE`），因此可观测面读到的是**契约错误码**而不是原始 23514；两者本臂都实测；
//       ③ 该 `event_key` 的消息行**0 行**（不是"谎报成功"、也没有半条）；
//       ④ 摘掉约束后同一事件再投递 ⇒ `delivered:true`/`created:true` 且恰好一行（失败确实没留残行）。
//   [R] **恢复**：关掉 app 与连接池（进程内状态清空）后，用**新连接池 + 新 store**（不经 `buildApp`）与
//       **新 app 实例**两条路径重读：消息行仍在、未读数=派生值、已读那条的 `read_at` 与关闭前**逐字相等**、
//       `revision` 不回退。真库重启语义按派单允许的「新建连接/新实例」模拟。
//
// 诚实边界（**不构成 #17 完成**）：
//   - 页面端到端仍**未取得**：本片不碰任何客户端（小程序/H5/后台），没有"用户真的看到未读红点"的读数；
//   - `reference_state`：本臂顺带读到 `available`（社区可见性端口已在 `app.ts` 后绑定），但这**不是**
//     「跳转真的能打开某个页面」的证据 —— 页面端到端仍缺；
//   - 「失败可观测」目前只有**端口回传值**（`CommunityEventDelivery.delivered/reason`）：装配层不记日志、
//     不出指标，`community/service.ts` 的 `publishInteraction`/`publishModerationResult` 按既有纪律
//     **吞掉**该返回值（内容写入权威性优先）⇒ 一次投递失败在 HTTP 响应面上不可见。这是**既有设计**，
//     本片如实登记，不改产品行为；
//   - 真实模型端口一律**合成替身**（`makeSyntheticPassPort`，`provider.synthetic === true`，不联网、
//     不带凭据）：本片证明的是**接线与落库**，不是审核准确率/召回率；
//   - 端口实例的构造口径：装配层只 decorate 了 `messagesService`/`communityService`，**没有**把
//     `communityEvents` 挂出来 ⇒ [F] 用与 `app.ts` **同一表达式**构造端口
//     （`createMessagesCommunityEventsPort({ messages: app.messagesService })`），复用的正是 app 里
//     那**一个**消息服务实例，不是第二套装配。
//
// ⛔ 本脚本不改任何产品代码、不改契约、不新增迁移；只读消费既有实现。

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { createPostgresMessagesStore } from '../../services/api/src/messages/store-pg.ts';
import { MESSAGE_TYPES, REFERENCE_STATES } from '../../services/api/src/messages/types.ts';
import {
  communityEventKey,
  communityEventMessageType,
  createMessagesCommunityEventsPort,
} from '../../services/api/src/community/events.ts';
import { CLEAN_BODY, CLEAN_TITLE, makeGate, makeSyntheticPassPort } from '../unit/community-fixtures.mjs';
import { FROZEN_RULE_OPTIONS } from '../unit/community-moderation-fixtures.mjs';

const API = '/api/v1';
const DB = 'gengyun_message_events_test';
/** 临时失败窗口的约束名：只在本进程的生命周期内存在，`finally` 里必摘。 */
const FAIL_WINDOW = 'gy_message_events_fail_window';
/** 契约 `Message` 的七字段（`event_key`/`owner_id` 不在契约里）。 */
const CONTRACT_FIELDS = ['created_at', 'id', 'read_at', 'reference_state', 'revision', 'target_ref', 'type'];

const ownerUrl = new URL(process.argv[2] ?? `postgres://postgres@127.0.0.1:5432/${DB}`);
assert.ok(['postgres:', 'postgresql:'].includes(ownerUrl.protocol), '连接串必须是 postgres URL');
assert.equal(ownerUrl.hostname, '127.0.0.1', '本测试只允许回环地址');
assert.equal(ownerUrl.pathname, `/${DB}`, `库名必须硬钉为 ${DB}（防误连）`);

let passed = 0;
const note = (line) => console.log(line);
const say = (message) => {
  passed += 1;
  console.log(`PASS ${passed}: ${message}`);
};
const unread = (label, why) => note(`未取得 ${label}：${why}`);

const owner = new pg.Client({ connectionString: ownerUrl.href });
/** 建过但未关闭的 app / 连接池：不关会让 node 进程挂着不退出。 */
const registeredApps = [];
const registeredPools = [];
await owner.connect();
const q = async (text, params = []) => (await owner.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];
const countOf = async (text, params = []) => Number((await one(text, params)).v);

const subjectOf = (label) => randomBytes(32).toString('hex').replace(/^(.{56}).{8}$/, `$1${label.padStart(8, '0')}`);

/**
 * SQL 直读的 timestamptz 被 node-pg 解析成 `Date` 对象（两次相等的读数也是**不同实例**），
 * 因此逐字比对前先归一到 `toISOString()`（与 `store-pg.ts::asIso` 同口径：恒 3 位毫秒）。
 */
const isoOf = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

/** 新建一个连接池（每个「实例」各一枚，模拟进程重启后的新连接）。 */
function newPool() {
  const pool = new pg.Pool({ connectionString: ownerUrl.href });
  registeredPools.push(pool);
  return pool;
}

/**
 * 与 `messages-pg.mjs` / `community-pg.mjs` 同一形状的装配：stub 执行模式 + 真连接池。
 *
 * 为什么**不能**用 `executionMode:'real'`：real 下审核域整域 fail-closed（未授权真实 tms/ims 供应商），
 * 社区写路径一律 503（`community-pg.mjs` 已把这条读数列为既有事实）⇒ 那样根本发不出社区事件。
 * 消息落库则靠**显式注入 PG store**（`messagesInjection.store`，装配层为测试预留的注入点），
 * 与 real 模式下 `app.ts` 自己选 `createPostgresMessagesStore({ pool })` 是**同一实现**。
 */
async function launchApp({ pool }) {
  const config = {
    ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    sessionSigningKey: randomBytes(32).toString('hex'),
  };
  const app = buildApp({
    config,
    pool,
    now: () => new Date(),
    messagesInjection: { store: createPostgresMessagesStore({ pool }) },
    communityInjection: { gate: makeGate() },
    // 合成替身端口（`provider.synthetic === true`）：只证明接线与落库，不是真实供应商调用。
    // 规则层注入冻结时钟：判定只由内容决定，不由机器负载决定（超时会被判隔离，那是负载在决定内容）。
    moderationInjection: { ports: { tms: makeSyntheticPassPort('tms') }, ruleOptions: FROZEN_RULE_OPTIONS },
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const call = async (path, { method = 'GET', token, headers = {} } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body, text, etag: response.headers.get('etag') };
  };
  registeredApps.push(app);
  return { app, call };
}

/** 读一条消息的八列（`event_key` 是内部列，不出契约）。 */
const messageRow = async (ownerId, eventKey) => one(
  `SELECT id, revision, owner_id, type, target_ref, read_at, created_at, event_key
     FROM public.messages
    WHERE owner_id = $1::uuid AND event_key = $2`,
  [ownerId, eventKey],
);
const messageCountFor = async (ownerId, eventKey) => countOf(
  'SELECT count(*)::int AS v FROM public.messages WHERE owner_id = $1::uuid AND event_key = $2',
  [ownerId, eventKey],
);

// ---------------------------------------------------------------------------
// [M] 前提：空库 + 全链迁移自举
// ---------------------------------------------------------------------------
async function migrationBootstrap() {
  const publicTables = await countOf("SELECT count(*)::int AS v FROM pg_tables WHERE schemaname = 'public'");
  assert.equal(publicTables, 0, `库 ${DB} 必须是空库（现场 public 表 ${publicTables} 张）——请先 createdb 一个干净的库`);

  const migrations = discoverMigrations();
  assert.ok(migrations.length > 0, '迁移清单不得为空（否则下面 apply 之后什么都不会建）');
  const applied = await applyMigrations(owner, migrations);
  assert.equal(applied.applied.length, migrations.length, '空库上必须把整条迁移链都应用一次');
  note(`[M] 空库 + 全链迁移自举：${migrations.length} 个迁移，本次应用 ${applied.applied.length} 个`);

  // 本臂**只消费** messages 表（它的 UP/ROLLBACK/REPLAY 三连由 `messages-pg.mjs` 负责，不在这里重复）。
  const table = (await one("SELECT to_regclass('public.messages') AS v")).v;
  assert.equal(table, 'messages', 'public.messages 必须在岗（它的存在性由 0019 负责）');
  const unique = await countOf(
    "SELECT count(*)::int AS v FROM pg_constraint WHERE conname = 'messages_owner_event_key' AND contype = 'u'",
  );
  assert.equal(unique, 1, '(owner_id, event_key) 唯一约束必须在岗：本臂的「去重由数据库裁决」全靠它');
  say('[M] 空库自举成功；public.messages 与 (owner_id, event_key) 唯一约束在岗（迁移三连不在此重复）');
}

// ---------------------------------------------------------------------------
// [W] 落库：三类事件各经社区服务真实写路径落成一条消息
// ---------------------------------------------------------------------------
async function deliveryArm({ service, call, authorA, authorB, tokenA }) {
  // ① 发帖 ⇒ 审核结论事件（`moderation_result` ⇒ 类型 `moderation`）
  const post = await service.createPost(authorA, { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] }, {
    idempotencyKey: 'message-events-post-1',
  });
  const moderationRow = await one(
    `SELECT id, revision, owner_id, type, target_ref, read_at, created_at, event_key
       FROM public.messages
      WHERE owner_id = $1::uuid AND type = 'moderation' AND target_ref->>'id' = $2`,
    [authorA.userId, post.id],
  );
  assert.notEqual(moderationRow, undefined, `发帖后必须落一条审核结论消息（target post=${post.id}）`);
  const decision = /\br1:([a-z_]+)$/.exec(String(moderationRow.event_key))?.[1];
  assert.notEqual(decision, undefined, `审核结论消息的 event_key 形状不符：${moderationRow.event_key}`);
  const moderationEvent = {
    event: 'moderation_result',
    ownerId: authorA.userId,
    target: { type: 'post', id: post.id, revision: 1 },
    decision,
    reasonCodes: [],
  };
  // 反向核对：库里的 event_key 必须**逐字等于** `communityEventKey` 对同一事件的产出。
  assert.equal(
    moderationRow.event_key,
    communityEventKey(moderationEvent),
    '`moderation_result` 的 event_key 必须与 communityEventKey 逐字相等',
  );
  assert.equal(moderationRow.type, communityEventMessageType(moderationEvent), '类型必须按 communityEventMessageType 映射');
  assert.equal(moderationRow.type, 'moderation', '审核结论消息的类型必须是 moderation');
  // 干净文本 + 合成放行端口 + 冻结规则时钟 ⇒ 结论应为 approved（发布闸门据此放行）。
  assert.equal(decision, 'approved', `干净文本的审核结论必须是 approved（现场 ${decision}）`);

  // ② 他人评论 ⇒ `comment_created`（类型 `comment`）
  const comment = await service.createComment(authorB, post.id, { body: '按标签说明处理，注意轮换用药。' }, {
    idempotencyKey: 'message-events-comment-1',
    ifMatch: `"${post.revision}"`,
  });
  const commentEvent = {
    event: 'comment_created',
    ownerId: authorA.userId,
    target: { type: 'post', id: post.id, revision: post.revision },
    commentId: comment.id,
    actorId: authorB.userId,
  };
  const commentKey = communityEventKey(commentEvent);
  const commentRow = await messageRow(authorA.userId, commentKey);
  assert.notEqual(commentRow, undefined, `他人评论后必须落一条 comment 消息（期望 event_key=${commentKey}）`);
  assert.equal(commentRow.type, communityEventMessageType(commentEvent), '类型必须按 communityEventMessageType 映射');
  assert.equal(commentRow.type, 'comment', '他人评论消息的类型必须是 comment');

  // ③ 他人点赞 ⇒ `like_created`（类型 `like`）
  await service.likePosts(authorB, post.id, { idempotencyKey: 'message-events-like-1', ifMatch: `"${post.revision}"` });
  const likeEvent = {
    event: 'like_created',
    ownerId: authorA.userId,
    target: { type: 'post', id: post.id, revision: post.revision },
    actorId: authorB.userId,
  };
  const likeKey = communityEventKey(likeEvent);
  const likeRow = await messageRow(authorA.userId, likeKey);
  assert.notEqual(likeRow, undefined, `他人点赞后必须落一条 like 消息（期望 event_key=${likeKey}）`);
  assert.equal(likeRow.type, communityEventMessageType(likeEvent), '类型必须按 communityEventMessageType 映射');
  assert.equal(likeRow.type, 'like', '他人点赞消息的类型必须是 like');

  // 八列逐列核对（三类事件一起；`read_at` 必须为 NULL：创建不当已读）
  for (const [label, row] of [['moderation', moderationRow], ['comment', commentRow], ['like', likeRow]]) {
    assert.match(String(row.id), /^[0-9a-f-]{36}$/i, `${label}：id 必须是 uuid 形状`);
    assert.equal(Number(row.revision), 1, `${label}：新建消息的 revision 必须从 1 开始`);
    assert.equal(row.owner_id, authorA.userId, `${label}：接收者必须是内容作者（不是互动者）`);
    assert.ok(MESSAGE_TYPES.includes(row.type), `${label}：type 必须在契约闭集内（现场 ${row.type}）`);
    assert.equal(row.read_at, null, `${label}：新消息必须未读（发送/创建不当已读）`);
    assert.equal(Number.isFinite(new Date(row.created_at).getTime()), true, `${label}：created_at 必须可解析为时间`);
    assert.equal(typeof row.event_key, 'string', `${label}：event_key 必须落库（内部去重列）`);
    assert.deepEqual(Object.keys(row.target_ref).sort(), ['id', 'revision', 'type'], `${label}：target_ref 必须是契约三字段`);
    assert.equal(row.target_ref.type, 'post', `${label}：跳转目标必须是帖子（评论行对他人未必可读）`);
    assert.equal(row.target_ref.id, post.id, `${label}：target_ref.id 必须指向被处置/被互动的帖子`);
    assert.equal(Number(row.target_ref.revision), 1, `${label}：revision 取事件发生时刻的版本`);
  }
  say(`[W] 三类社区事件经真实写路径各落一行：moderation(${decision}) / comment / like，八列逐列与契约一致`);

  // 契约投影：HTTP 面只出七字段，内部列不外泄；`reference_state` 只取闭集取值。
  const list = await call(`${API}/messages`, { token: tokenA });
  assert.equal(list.status, 200, `GET /messages 必须 200（现场 ${list.status}：${list.text}）`);
  const items = list.body.data.items;
  assert.equal(items.length, 3, `此刻 A 必须恰好 3 条消息（现场 ${items.length}）`);
  for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), CONTRACT_FIELDS, 'HTTP 投影必须恰好是契约七字段（无 owner_id/event_key）');
    assert.ok(REFERENCE_STATES.includes(item.reference_state), `reference_state 必须取闭集（现场 ${item.reference_state}）`);
  }
  const unreadCount = await call(`${API}/messages/unread-count`, { token: tokenA });
  assert.equal(unreadCount.status, 200);
  assert.equal(unreadCount.body.data.count, 3, '三条都未读 ⇒ 未读派生计数必须是 3');
  // 逐次现查的 `reference_state`：帖子此刻已发布且审核通过 ⇒ 社区可见性端口应给出 available。
  assert.deepEqual(
    items.map((item) => item.reference_state),
    ['available', 'available', 'available'],
    '帖子已发布且审核通过 ⇒ 三条消息的跳转目标当前都应可用（逐次现查，不是入库状态）',
  );
  say('[W] HTTP 面：3 条未读、契约七字段无内部列外泄、reference_state 三条都是 available（逐次现查）');

  return {
    post,
    moderation: { key: moderationRow.event_key, id: moderationRow.id },
    /** 社区评论对象（`id` = 评论 id，≠ 消息 id）。 */
    comment,
    /** 「他人评论」那条**消息**的 id（标读/恢复臂的靶子）。 */
    commentMessage: { key: commentKey, id: commentRow.id },
    like: { key: likeKey, id: likeRow.id },
  };
}

// ---------------------------------------------------------------------------
// [D] 幂等/去重：同一 communityEventKey 重复投递不产生第二行
// ---------------------------------------------------------------------------
async function dedupeArm({ service, pool, authorA, authorB, post, likeKey, likeRowId }) {
  const before = await messageRow(authorA.userId, likeKey);
  assert.notEqual(before, undefined, '去重臂前提：点赞消息必须已存在');
  assert.equal(before.id, likeRowId, '去重臂前提：行 id 与 [W] 读到的一致');

  // ① 端到端重复调度：取消赞 → 重新赞（新幂等键）⇒ `addLike` 再次返回「新增」⇒ 同一事件键再投递一次。
  await service.unlikePosts(authorB, post.id, { idempotencyKey: 'message-events-unlike-1', ifMatch: `"${post.revision}"` });
  await service.likePosts(authorB, post.id, { idempotencyKey: 'message-events-like-2', ifMatch: `"${post.revision}"` });
  const rows = await messageCountFor(authorA.userId, likeKey);
  assert.equal(rows, 1, `同一 communityEventKey 重复投递后仍必须恰好 1 行（现场 ${rows}）`);
  const after = await messageRow(authorA.userId, likeKey);
  assert.equal(after.id, before.id, '去重必须返回既有行（不得新建第二条）');
  assert.equal(after.created_at && isoOf(after.created_at), isoOf(before.created_at), '去重不得改动既有行的时间戳');
  assert.equal(after.read_at, before.read_at, '去重不得重置读状态');

  // ② 真库裁决：绕过服务层，直接对 PG store 用同一 (owner_id, event_key) 再写一次 ⇒ duplicate。
  const rawStore = createPostgresMessagesStore({ pool });
  const raw = await rawStore.insertMessage({
    id: '00000000-0000-4000-8000-0000000000ff',
    revision: 1,
    owner_id: authorA.userId,
    type: 'like',
    target_ref: { type: 'post', id: post.id, revision: post.revision },
    read_at: null,
    created_at: new Date().toISOString(),
    event_key: likeKey,
  });
  assert.equal(raw, 'duplicate', '同 (owner_id, event_key) 直插必须由唯一约束判为 duplicate（不是应用层先查后写）');
  assert.equal(await messageCountFor(authorA.userId, likeKey), 1, '直插被判 duplicate 后行数必须仍是 1');
  say('[D] 同一 communityEventKey：端到端重复调度 + 直插 PG store 两条路径都只有 1 行，且既有行 id/时间戳/读状态逐字不变');
}

// ---------------------------------------------------------------------------
// [F] 失败隔离 + 失败可观测（真打断消息落库，内容写入照常成功）
// ---------------------------------------------------------------------------
async function isolationArm({ service, app, authorA, authorB }) {
  // 先造一篇新帖（此时约束还没加，它的审核结论消息正常落库）。
  const post = await service.createPost(authorA, { title: '苗期观察记录', body: '这段时间天气转凉，我记录了田间长势。', media_ids: [] }, {
    idempotencyKey: 'message-events-post-2',
  });
  const likeEvent = {
    event: 'like_created',
    ownerId: authorA.userId,
    target: { type: 'post', id: post.id, revision: post.revision },
    actorId: authorB.userId,
  };
  const likeKey = communityEventKey(likeEvent);

  // 与 `app.ts` 装配处**同一表达式**的端口实例（复用 app 里那**一个** messagesService）。
  const port = createMessagesCommunityEventsPort({ messages: app.messagesService });
  assert.equal(port.wired, true, '端口必须自述已接线');

  await owner.query(`ALTER TABLE public.messages ADD CONSTRAINT ${FAIL_WINDOW} CHECK (type <> 'like') NOT VALID`);
  try {
    // ① 内容写入照常成功：他人点赞走社区服务真实写路径。
    await service.likePosts(authorB, post.id, { idempotencyKey: 'message-events-like-fail', ifMatch: `"${post.revision}"` });
    const likeRows = await countOf(
      'SELECT count(*)::int AS v FROM public.community_likes WHERE target_id = $1::uuid AND user_id = $2::uuid',
      [post.id, authorB.userId],
    );
    assert.equal(likeRows, 1, '消息投递失败不得影响内容写入：点赞行必须真的落库');

    // ② 该事件的消息行 0 行（不是谎报成功，也没有半条）。
    assert.equal(await messageCountFor(authorA.userId, likeKey), 0, '消息域真失败时不得留下任何消息行');

    // ③ 失败窗口确实由**数据库**拒绝：绕开领域层直插一条 like 消息，读原始 PG 错误码。
    let rawCode = null;
    try {
      await owner.query(
        `INSERT INTO public.messages (id, owner_id, type, target_ref, read_at, created_at, revision, event_key)
              VALUES (gen_random_uuid(), $1::uuid, 'like', $2::jsonb, NULL, now(), 1, $3)`,
        [authorA.userId, JSON.stringify({ type: 'post', id: post.id, revision: post.revision }), `${likeKey}:raw-probe`],
      );
    } catch (error) {
      rawCode = error?.code ?? null;
    }
    assert.equal(rawCode, '23514', `失败窗口必须真的由数据库拒绝（期望 23514 check_violation，现场 ${rawCode}）`);

    // ④ 失败可观测：端口回传 delivered:false + reason。`messages/store-pg.ts` 把驱动错误**折叠**成契约
    //    错误码（`57014`/`55P03` ⇒ PROVIDER_TIMEOUT，其余 ⇒ PROVIDER_UNAVAILABLE），因此可观测的
    //    `reason` 是**契约闭集错误码**，不是原始 23514 —— 这是既有口径，本片如实登记。
    const failed = await port.publish(likeEvent);
    assert.equal(failed.delivered, false, '投递失败必须如实回传 delivered:false（⛔ 不得谎报成功）');
    assert.equal(failed.created, false, '投递失败不得声称 created');
    assert.equal(failed.messageId, null, '投递失败不得编造 messageId');
    assert.equal(
      failed.reason,
      'PROVIDER_UNAVAILABLE',
      `失败原因必须可观测（期望契约错误码 PROVIDER_UNAVAILABLE，现场 ${failed.reason}）`,
    );
    assert.equal(await messageCountFor(authorA.userId, likeKey), 0, '失败之后再读仍必须 0 行');
    say(
      `[F] 消息落库真失败：数据库侧 23514、端口侧折叠为 ${failed.reason}；`
      + '内容点赞行照常 1 行、消息 0 行',
    );
  } finally {
    await owner.query(`ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS ${FAIL_WINDOW}`);
  }

  // ④ 摘掉约束后同一事件再投递 ⇒ 成功且恰好一行（失败确实没留残行，路径能恢复）。
  const recovered = await port.publish(likeEvent);
  assert.equal(recovered.delivered, true, `摘掉约束后同一事件必须能投递（现场 ${JSON.stringify(recovered)}）`);
  assert.equal(recovered.created, true, '此前从未成功落库 ⇒ 这次必须是 created:true（证明失败窗口没留半条）');
  assert.equal(await messageCountFor(authorA.userId, likeKey), 1, '恢复后该事件恰好一行');
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM pg_constraint WHERE conname = $1', [FAIL_WINDOW]),
    0,
    '临时失败窗口的约束必须在收尾时摘干净（不留 schema 残留）',
  );
  say('[F] 摘掉约束后同一事件投递成功且只落 1 行（created:true）⇒ 失败没有留残行，临时约束已摘干净');

  return { post, likeKey };
}

// ---------------------------------------------------------------------------
// [R] 恢复：进程内状态清空后，新连接/新实例仍读得到未读与已读
// ---------------------------------------------------------------------------
async function recoveryArm({ call, authorA, tokenA, readId, totalMessages, expectedUnread }) {
  // ① 关闭前：把其中一条标记为已读（走真 HTTP + 真库）。
  const marked = await call(`${API}/messages/${readId}/read`, {
    method: 'PUT',
    token: tokenA,
    headers: { 'idempotency-key': 'message-events-read-1', 'if-match': '"1"' },
  });
  assert.equal(marked.status, 200, `首次标记已读必须 200（现场 ${marked.status}：${marked.text}）`);
  const versionBefore = marked.body.data.revision;
  const readAtBefore = marked.body.data.read_at;
  assert.equal(versionBefore, 2, '标记已读必须推进一版（1→2）');
  assert.equal(typeof readAtBefore, 'string', '标记后 read_at 必须非空');
  assert.equal(marked.etag, '"2"', 'ETag 必须跟着新版本走');

  const unreadBefore = await call(`${API}/messages/unread-count`, { token: tokenA });
  assert.equal(unreadBefore.body.data.count, expectedUnread, `关闭前未读数必须等于派生值 ${expectedUnread}`);

  // ② 清空进程内状态：关掉**全部** app 与**全部**连接池。
  for (const instance of registeredApps.splice(0)) await instance.close().catch(() => {});
  for (const pool of registeredPools.splice(0)) await pool.end().catch(() => {});

  // ③ 新连接池 + 新 store（**不经 buildApp**）直接读库。
  const pool = newPool();
  const freshStore = createPostgresMessagesStore({ pool });
  assert.equal(freshStore.persistent, true, '新 store 必须自述持久化');
  const rows = await freshStore.listMessagesByOwner(authorA.userId);
  assert.equal(rows.length, totalMessages, `新 store 必须读回全部 ${totalMessages} 条消息（现场 ${rows.length}）`);
  const freshUnread = await freshStore.countUnread(authorA.userId);
  assert.equal(freshUnread, expectedUnread, `新 store 的未读数必须等于派生值 ${expectedUnread}（现场 ${freshUnread}）`);
  const readRow = rows.find((row) => row.id === readId);
  assert.notEqual(readRow, undefined, '已读那条必须仍在新 store 的列表里');
  assert.equal(readRow.read_at, readAtBefore, '已读时间戳必须与关闭前**逐字相等**（读状态真的在库里）');
  assert.equal(readRow.revision, versionBefore, '已读行的 revision 不得回退');
  const viaSql = await countOf(
    'SELECT count(*)::int AS v FROM public.messages WHERE owner_id = $1::uuid AND read_at IS NULL',
    [authorA.userId],
  );
  assert.equal(viaSql, expectedUnread, 'SQL 直读的未读行数必须与新 store 的派生值一致');

  // ④ 新 app 实例（新池、重新装配）+ 同一会话 token：HTTP 面读数必须与关闭前一致。
  const { call: callAgain } = await launchApp({ pool });
  const relisted = await callAgain(`${API}/messages`, { token: tokenA });
  assert.equal(relisted.status, 200, `新 app 实例的 GET /messages 必须 200（现场 ${relisted.status}：${relisted.text}）`);
  const items = relisted.body.data.items;
  assert.equal(items.length, totalMessages, `新 app 实例必须读回全部 ${totalMessages} 条消息（现场 ${items.length}）`);
  const reRead = items.find((item) => item.id === readId);
  assert.notEqual(reRead, undefined, '已读那条必须仍在 HTTP 投影里');
  assert.equal(reRead.read_at, readAtBefore, 'HTTP 面读到的已读时间戳必须逐字不变');
  assert.equal(reRead.revision, versionBefore, 'HTTP 面读到的 revision 不得回退');
  const unreadAfter = await callAgain(`${API}/messages/unread-count`, { token: tokenA });
  assert.equal(unreadAfter.body.data.count, expectedUnread, `新 app 实例的未读数必须仍是 ${expectedUnread}`);
  say(
    `[R] 进程内状态清空（关 app + 关池）后：新 store 读回 ${rows.length} 条、未读 ${freshUnread}；`
    + `新 app 实例 HTTP 读回 ${items.length} 条、未读 ${unreadAfter.body.data.count}；已读时间戳逐字不变`,
  );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
try {
  await migrationBootstrap();

  const pool = newPool();
  const authStore = createPostgresAuthStore({ query: (text, params) => pool.query(text, params) });
  const { app, call } = await launchApp({ pool });
  assert.notEqual(app.messagesService, null, 'stub + 注入 PG store ⇒ 消息服务必须接线');
  assert.notEqual(app.communityService, null, 'stub + 真 pool ⇒ 社区服务必须开启（否则发不出社区事件）');

  const userA = await authStore.createUser(subjectOf('00003401'));
  const userB = await authStore.createUser(subjectOf('00003402'));
  const tokenA = mintOpaqueToken();
  await authStore.createSession({
    userId: userA.id,
    tokenHashHex: hashToken(tokenA),
    authEpoch: userA.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });
  const authorA = { userId: userA.id, role: 'user', authEpoch: userA.authEpoch };
  const authorB = { userId: userB.id, role: 'user', authEpoch: userB.authEpoch };
  note(`[0] 用户 A ${userA.id} / B ${userB.id} 已在 users 表落库；会话走真实 PG`);

  const delivered = await deliveryArm({ service: app.communityService, call, authorA, authorB, tokenA });
  await dedupeArm({
    service: app.communityService,
    pool,
    authorA,
    authorB,
    post: delivered.post,
    likeKey: delivered.like.key,
    likeRowId: delivered.like.id,
  });
  await isolationArm({ service: app.communityService, app, authorA, authorB });

  // 落库总量：moderation(P1) + comment(P1) + like(P1) + moderation(P2) + like(P2，失败窗口后补投) = 5
  const totalMessages = await countOf('SELECT count(*)::int AS v FROM public.messages WHERE owner_id = $1::uuid', [userA.id]);
  assert.equal(totalMessages, 5, `A 的消息总数必须是 5（现场 ${totalMessages}）`);
  const unreadTotal = await countOf(
    'SELECT count(*)::int AS v FROM public.messages WHERE owner_id = $1::uuid AND read_at IS NULL',
    [userA.id],
  );
  assert.equal(unreadTotal, 5, '标记已读之前五条都未读');
  // 接收者口径：B 只是**互动者**，他收到的唯一一条必须是**自己评论**的审核结论
  // （自己被处置的内容通知本人），而不是 A 的评论/点赞消息。
  const bRows = await q(
    'SELECT type, target_ref, read_at FROM public.messages WHERE owner_id = $1::uuid',
    [userB.id],
  );
  assert.equal(bRows.length, 1, `B 只该收到自己评论的审核结论一条（现场 ${bRows.length} 条）`);
  assert.equal(bRows[0].type, 'moderation', 'B 那一条必须是自己评论的审核结论（不是 interaction 消息）');
  assert.equal(bRows[0].target_ref.type, 'comment', 'B 的审核结论目标必须是那条评论');
  assert.equal(bRows[0].target_ref.id, delivered.comment.id, 'B 的审核结论必须指向 B 自己写的那条评论');
  assert.equal(Number(bRows[0].target_ref.revision), 1, '评论审核结论的 revision 必须是 1');
  say('[W] 接收者口径：A 收 5 条（三类事件都指向内容作者）、B 只收自己评论的 1 条审核结论（互动者不收他人消息）');

  await recoveryArm({
    call,
    authorA,
    tokenA,
    readId: delivered.commentMessage.id,
    totalMessages,
    expectedUnread: totalMessages - 1,
  });

  note('[√] ALL PASS：社区事件 → 消息域 的真库投递/去重/失败隔离/恢复（迁移自举 + 三类事件 + 唯一键去重 + 23514 失败窗口 + 新实例重读）');
} finally {
  await owner.query(`ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS ${FAIL_WINDOW}`).catch(() => {});
  for (const instance of registeredApps.splice(0)) await instance.close().catch(() => {});
  for (const pool of registeredPools.splice(0)) await pool.end().catch(() => {});
  await owner.end().catch(() => {});
}

console.log(`TOTAL PASS = ${passed}`);

// ---- 未取得项（**不得**把未跑写成通过） ----
unread('页面端到端（未读红点/收件箱页面）', '本片只覆盖后端真库与 HTTP 契约，客户端未改也未在真机跑 ⇒ 不构成 #17 完成');
unread('跳转真能打开目标页面', '本臂读到 reference_state=available（社区可见性端口已接线），但没有页面级跳转读数');
unread('投递失败的日志/指标出口', '现有实现只有端口回传 delivered:false+reason；服务层按既有纪律吞掉该返回值，无第二观测面');
unread('真实模型端口', '审核端口是合成替身（provider.synthetic=true，不联网、无凭据）⇒ 不构成审核准确率/召回率证据');
unread('多进程并发投递同一事件键', '本片在单进程内重复调度 + 直插 store 两条路径验证唯一键；未做跨进程并发压测');
unread('>1 万行规模与万级未读计数', '本片 5 条消息验证语义，未做规模基准');
