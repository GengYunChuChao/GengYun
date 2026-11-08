/**
 * A 档回归 · 社区「下架」事件到消息中心的**正向订阅**（GY-I14 / 通知面）。
 *
 * ## 本文件钉住什么（2026-11，基线 `0221e69c`）
 *
 * 后台下架成功（CAS 返回 `ok:true` 且记录 `visibility === 'hidden'`）时，观察器
 * `withTakedownObserver`（`services/api/src/community/takedown.ts:58`）会在 CAS **返回之后**
 * （同文件 `:82-83`）、**事务之外**补发一条 `takedown` 事件（同文件 `:88-93`）；唯一的订阅者是
 * 消息域端口 `createMessagesCommunityEventsPort`（`services/api/src/community/events.ts:164-195`）。
 * 本文件用**真**的该端口 + 一份内存消息端口，钉住这条链路的正向结果：**恰好 1 条**
 * `type === 'moderation'` 的消息，键精确为
 * `community:takedown:post:<id>:r<处置前 revision>:admin_hide`
 * （键格式见 `services/api/src/community/events.ts:112-118`，takedown 分支取 `:<reason>`
 * 且只取前 80 字；缺省 reason `admin_hide` 见 `services/api/src/community/takedown.ts:62`）。
 *
 * ## 与既有负向钉的分工
 *
 * `tests/unit/community-notify-dedupe-pins.test.mjs:130` 钉的是反方向：「重审驳回**不**产生
 * `community:takedown:` 键」。只钉负向的话，把观察器整段删掉也能全绿；本文件补上正向那一半，
 * 于是「观察器失灵」（漏发）与「观察器越界」（多发）两种相反的回归各有一条红灯。
 *
 * ## 版本口径（① 的核心）
 *
 * `target.revision` 必须是 `expected.revision`＝**处置前那一版**，不是 `result.record.revision`。
 * 理由写在 `services/api/src/community/takedown.ts:49-56`：被公开发布、被读取缓存、被审核域
 * `cache.invalidateTarget` 键住的都是处置前那一版；隐藏会把 revision +1（同文件 `:52`），
 * 事件若带处置后的版本，任何「按事件失效缓存/核对版本」的消费者都会算错键。
 * 本文件的假 store 让 `patch.revision = expected.revision + 1`
 * （与真适配层 `services/api/src/admin/ops/community-posts.ts:97` 同形），
 * 所以「拿错版本」这条变异一定会被 ① 抓住。
 *
 * ## 本文件**不**声称
 *
 * - 不声称 real 域（`persistent === true`）的「下架 ⇒ 缓存失效」钩子已接：那是
 *   `services/api/src/app.ts:1481-1483` 的既有裁定（real 未注入审核权威时不挂
 *   `withModerationTakedownLink`，否则会把一次已生效的下架折成 503）。
 * - 不声称通知改成了事务性 outbox：投递在 `commitPostIfCurrent` **返回之后**、事务之外
 *   （`services/api/src/community/takedown.ts:82-98`），失败被空 catch 吞掉
 *   （同文件 `:95-97`，纪律见同文件 `:21-22`）。
 * - 不声称真库的 `messages_owner_event_key` 索引在本文件里被真正执行：内存端口复刻的是它的
 *   **语义**（`services/api/db/migrations/0019_messages_persistence.sql:67-68`），真库行为在
 *   迁移与集成层验收。
 *
 * ## 替身口径
 *
 * - community store 是**假**的：只实现 `persistent` / `getPost` / `commitPostIfCurrent`
 *   （端口形状见 `services/api/src/community/takedown.ts:34`），CAS 只比 `id` / `revision` /
 *   `visibility`；`moderation` 与第 5 个 `audit` 实参被忽略（真库语义见
 *   `services/api/src/community/store.ts:426-432`）。
 * - messages 端口是**内存**的：复刻 `services/api/src/messages/service.ts:424-425`
 *   「同 `(owner_id, event_key)` 命中已有行 ⇒ `created:false`、不新建行」。
 * - 事件端口是**真** `createMessagesCommunityEventsPort`（`services/api/src/community/events.ts:164`），
 *   外面只加一层记录器，把观察器实际发出去的事件原样留一份，供 ② 做「同一事件重投」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessagesCommunityEventsPort } from '../../services/api/src/community/events.ts';
import { withTakedownObserver } from '../../services/api/src/community/takedown.ts';

const POST_ID = 'post-i14-0001';
const AUTHOR_ID = 'user-i14-author';
/** 处置前（被下架的那一版）。 */
const PRE_REVISION = 1;
/** 处置后（隐藏必然把 revision +1，见 `services/api/src/community/takedown.ts:52`）。 */
const POST_REVISION_AFTER_HIDE = PRE_REVISION + 1;
/** 观察器缺省处置原因（`services/api/src/community/takedown.ts:62`）。 */
const DEFAULT_REASON = 'admin_hide';
const EXPECTED_TAKEDOWN_KEY = `community:takedown:post:${POST_ID}:r${PRE_REVISION}:${DEFAULT_REASON}`;

/** 与真适配层同形的下架补丁（`services/api/src/admin/ops/community-posts.ts:97`）。 */
function hidePatch(previousRevision) {
  return {
    revision: previousRevision + 1,
    visibility: 'hidden',
    updated_at: '2026-11-08T14:00:00.000Z',
  };
}

/** 一条已发布、已过审的社区帖（字段对齐 `PostRecord`，见 `services/api/src/community/store.ts:19-40`）。 */
function postRecord(overrides = {}) {
  return {
    id: POST_ID,
    revision: PRE_REVISION,
    author_id: AUTHOR_ID,
    anonymized_author_ref: null,
    title: '菜心霜霉病怎么防',
    body: '叶片背面有白色霉层……',
    crop_id: 'crop-brassica',
    region_code: '440100',
    media_ids: [],
    linked_knowledge_ref: null,
    visibility: 'published',
    audit_state: 'approved',
    created_at: '2026-11-08T13:00:00.000Z',
    updated_at: '2026-11-08T13:00:00.000Z',
    ...overrides,
  };
}

/**
 * 内存版 messages 端口：复刻迁移 0019 的 `UNIQUE (owner_id, event_key)` 语义。
 *
 * ⛔ 不能「有调用就 `created:true`」：那样 ② 的去重读数就变成假绿（内存里直接返回 true，
 * 真库撞键时反而是 false）。这里按 `(owner_id, event_key)` 建索引，命中就回已有行。
 */
function makeMemoryMessagesPort() {
  const rows = [];
  const byOwnerKey = new Map();
  const calls = [];
  return {
    rows,
    calls,
    async appendMessage(input) {
      calls.push(input);
      const key = `${input.owner_id}\u0000${input.event_key}`;
      const existing = byOwnerKey.get(key);
      if (existing !== undefined) return { created: false, message: existing };
      const message = {
        id: `msg-${rows.length + 1}`,
        owner_id: input.owner_id,
        type: input.type,
        target_ref: input.target_ref,
        event_key: input.event_key,
        read_at: null,
        created_at: '2026-11-08T14:00:00.000Z',
      };
      rows.push(message);
      byOwnerKey.set(key, message);
      return { created: true, message };
    },
  };
}

/** 假 community store：CAS 只比 id / revision / visibility，提交后记录换成 `{...record, ...patch}`。 */
function makeFakeCommunityStore({ record = postRecord() } = {}) {
  const state = { record: { ...record } };
  const commits = [];
  return {
    persistent: true,
    commits,
    state,
    async getPost(id) {
      return id === state.record.id ? { ...state.record } : null;
    },
    async commitPostIfCurrent(id, expected, patch) {
      commits.push({ id, expected: { ...expected }, patch: { ...patch } });
      if (id !== state.record.id) return { ok: false, reason: 'NOT_FOUND' };
      if (expected.revision !== state.record.revision) return { ok: false, reason: 'REVISION_CHANGED' };
      if (expected.visibility !== undefined && expected.visibility !== state.record.visibility) {
        return { ok: false, reason: 'VISIBILITY_CHANGED' };
      }
      state.record = { ...state.record, ...patch };
      return { ok: true, record: { ...state.record } };
    },
  };
}

/**
 * 装配：假 store → 观察器 → **真**事件端口 → 内存消息端口。
 *
 * `published` 记录观察器实际发出去的事件对象（② 用它把**同一个事件**重投一次）；
 * `eventsPort` 留了口子给 ③ 的抛错替身。
 */
function wire({ record, eventsPort } = {}) {
  const store = makeFakeCommunityStore(record === undefined ? {} : { record });
  const messages = makeMemoryMessagesPort();
  const realEvents = createMessagesCommunityEventsPort({ messages });
  const published = [];
  const recordingEvents = {
    wired: true,
    note: '记录器：留一份观察器实际发出的事件，再原样交给真端口',
    async publish(event) {
      published.push(event);
      return realEvents.publish(event);
    },
  };
  const events = eventsPort ?? recordingEvents;
  const port = withTakedownObserver(store, { events });
  return { store, messages, published, realEvents, recordingEvents, events, port };
}

test('① 下架成功 ⇒ 恰好 1 条 moderation 消息，键与版本都取「处置前那一版」', async () => {
  const { messages, published, port } = wire();

  const result = await port.commitPostIfCurrent(
    POST_ID,
    { revision: PRE_REVISION, visibility: 'published' },
    hidePatch(PRE_REVISION),
    null,
  );

  // 前置：这是「隐藏成功」那一条路径，不是失败分支。
  assert.equal(result.ok, true, 'CAS 必须成功（前置条件）');
  assert.equal(result.record.visibility, 'hidden', '返回记录必须已是 hidden（前置条件）');
  assert.equal(
    result.record.revision,
    POST_REVISION_AFTER_HIDE,
    '处置后 revision 必须 +1 —— 这是「拿错版本」那条变异的可判别前提',
  );

  assert.equal(messages.calls.length, 1, `下架成功必须**恰好**投递 1 次，实际 ${messages.calls.length} 次`);
  assert.equal(messages.rows.length, 1, `消息行必须恰好 1 条，实际 ${messages.rows.length} 条`);
  assert.equal(published.length, 1, `观察器必须恰好发 1 个事件，实际 ${published.length} 个`);

  const [delivery] = messages.calls;
  // 键与字段**硬编码**：不调用 `communityEventKey` / `communityEventMessageType`，
  // 否则就是「用实现证明实现」——把实现改坏、两边一起改坏也照样绿。
  assert.deepEqual(
    delivery,
    {
      owner_id: AUTHOR_ID,
      type: 'moderation',
      target_ref: { type: 'post', id: POST_ID, revision: PRE_REVISION },
      event_key: EXPECTED_TAKEDOWN_KEY,
    },
    '投递入参必须逐字相等（事件端口只许传 owner_id / type / target_ref / event_key 四个字段）',
  );
  assert.equal(
    messages.rows[0].target_ref.revision,
    PRE_REVISION,
    'target_ref.revision 必须是处置前那一版（expected.revision），不是 result.record.revision',
  );
});

test('② 同一事件重投 ⇒ 第二次 created=false、行数仍 1；同一 expected 再提交也不再发事件', async () => {
  const { messages, published, realEvents, port } = wire();

  await port.commitPostIfCurrent(
    POST_ID,
    { revision: PRE_REVISION, visibility: 'published' },
    hidePatch(PRE_REVISION),
    null,
  );
  assert.equal(messages.rows.length, 1, '首次必须落 1 行（前置条件）');
  assert.equal(published.length, 1, '首次必须发出 1 个事件（前置条件）');

  // (a) 把观察器**实际发出去的那个事件**原样重投（至少一次投递语义；键相同就该命中已有行）。
  const replay = await realEvents.publish(published[0]);
  const replayAgain = await realEvents.publish(published[0]);
  assert.equal(replay.created, false, '重投同一事件必须 created:false（命中迁移 0019 的唯一索引语义）');
  assert.equal(replayAgain.created, false, '再投一次仍必须 created:false —— 不能无条件 return true');
  assert.equal(replayAgain.delivered, true, '去重是「已存在」，不是「投递失败」（delivered 必须仍为 true）');
  assert.equal(messages.rows.length, 1, `重投后行数必须仍是 1，实际 ${messages.rows.length} 条`);
  assert.deepEqual(
    messages.rows.map((row) => row.event_key),
    [EXPECTED_TAKEDOWN_KEY],
    '重投不得换键：换键会让真库的 UNIQUE (owner_id, event_key) 也拦不住第二条',
  );

  // (b) 同一次处置再提交一遍（同一 expected.revision）：真 CAS 只会 REVISION_CHANGED，
  //     观察器根本进不到发事件的守卫（`services/api/src/community/takedown.ts:83`）。
  const again = await port.commitPostIfCurrent(
    POST_ID,
    { revision: PRE_REVISION, visibility: 'published' },
    hidePatch(PRE_REVISION),
    null,
  );
  assert.equal(again.ok, false, '同一 expected 的第二次 CAS 必须失败（隐藏已把 revision 推到 2）');
  assert.equal(again.reason, 'REVISION_CHANGED', '失败原因必须是 REVISION_CHANGED');
  assert.equal(
    messages.calls.length,
    3,
    'appendMessage 共被调 3 次（观察器 1 次 + 上面两次重投），但行数仍是 1 —— 这正是「调了但没新建行」',
  );
  assert.equal(published.length, 1, '失败重投不得再发事件（观察器只在 CAS 成功时发，守卫在 `services/api/src/community/takedown.ts:83`）');
});

test('③ 负控制：事件端口抛错 ⇒ 下架仍 ok:true 且记录仍 hidden（不回滚，fail-open 是特性）', async () => {
  const thrown = [];
  const throwingEvents = {
    wired: true,
    note: '合成替身：只用于证明通知失败不回滚，不投递任何消息',
    async publish(event) {
      thrown.push(event);
      throw new Error('EVENT_PORT_UNAVAILABLE');
    },
  };
  const { store, port } = wire({ eventsPort: throwingEvents });

  const result = await port.commitPostIfCurrent(
    POST_ID,
    { revision: PRE_REVISION, visibility: 'published' },
    hidePatch(PRE_REVISION),
    null,
  );

  assert.equal(thrown.length, 1, '前置：观察器确实调用了会抛错的端口（不是「压根没走到」）');
  assert.equal(result.ok, true, '通知失败**不得**把一次已生效的合规处置折成失败（fail-open 是特性）');
  assert.equal(result.record.visibility, 'hidden', '返回记录仍是 hidden');
  assert.equal(store.state.record.visibility, 'hidden', '被处置记录本身仍是 hidden：没有回滚');
  assert.equal(
    store.state.record.revision,
    POST_REVISION_AFTER_HIDE,
    'CAS 已落库（revision 已 +1），不是「其实没写成功」',
  );
});

test('④ 匿名（author_id === null）下架 ⇒ 不发消息（没有可通知的账户主体）', async () => {
  const { messages, published, port } = wire({ record: postRecord({ author_id: null }) });

  const result = await port.commitPostIfCurrent(
    POST_ID,
    { revision: PRE_REVISION, visibility: 'published' },
    hidePatch(PRE_REVISION),
    null,
  );

  assert.equal(result.ok, true, 'CAS 必须成功（前置条件）');
  assert.equal(result.record.visibility, 'hidden', '记录仍必须被隐藏（处置照常生效）');
  assert.equal(result.record.author_id, null, '前置：这是已注销/匿名内容（迁移 0030 口径）');
  assert.equal(
    published.length,
    0,
    'author_id === null ⇒ 观察器不得发事件（守卫在 `services/api/src/community/takedown.ts:87`）',
  );
  assert.equal(messages.calls.length, 0, '不得投递任何消息');
  assert.equal(messages.rows.length, 0, '不得落任何消息行');
});
