/**
 * GY-I17（#17）· G4：消息跳转目标可用性接线（`reference_state`）的回归臂。
 *
 * 本文件钉住四条**用户可感**的性质（全部走真实 `buildApp` + 真实社区/审核/消息域）：
 *
 *   1. **能跳**：目标当前公开可读 ⇒ `available`（未接线时恒 `unavailable`，用户点不动）；
 *   2. **同形**：不存在 / 已删除（下架）/ 读不到的目标类型 ⇒ 一律 `unavailable`，
 *      三者在响应里**逐字同形**，不得据此区分目标处于哪种状态（存在性不泄露）；
 *   3. **动态**：同一条消息、同一个 id，删除前 `available`、删除后 `unavailable`——
 *      证明判定是**读取时重查**，不是投递时快照，也不靠清缓存；
 *   4. **不越权**：接线只发生在装配层，社区域除那一个只读谓词外没有对外暴露面。
 *
 * 为什么断言"赋值真的发生了"要用行为而不是计数：装配顺序是「先消息域、后社区域」，
 * 端口靠后绑定读取器拿社区判据；**漏掉那次赋值**的后果是**恒** `unavailable`（不是 500），
 * 因此"公开目标能跳到 available"本身就是赋值发生过的证据，而第 3 条又排除了"恒 available"。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { API, idem, passingPort, postInput, makeWiredHarness } from './community-moderation-fixtures.mjs';

const SRC_ROOT = new URL('../../services/api/src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const items = (res) => {
  assert.equal(res.status, 200, `GET /messages 必须 200，实际 ${res.status}`);
  return res.body.data.items;
};

/** 建一个"作者 A 的帖子 + 他人 B 的评论/点赞"的收件箱环境。 */
async function harnessWithInbox() {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const a = await h.session('a');
  const b = await h.session('b');
  return { h, a, b };
}

const seedMessage = async (h, ownerId, targetRef, key) => {
  const id = randomUUID();
  await h.messages.insertMessage({
    id,
    revision: 1,
    owner_id: ownerId,
    type: 'system',
    target_ref: targetRef,
    read_at: null,
    created_at: new Date(Date.now() + 1000).toISOString(),
    event_key: `g4:${key}:${id}`,
  });
  return id;
};

test('G4-1 能跳：目标当前公开可读 ⇒ reference_state=available（未接线时恒 unavailable）', async () => {
  const { h, a } = await harnessWithInbox();
  const post = await h.service.createPost(a.actor, postInput(), { idempotencyKey: idem(1) });
  const read = await h.inject('GET', `${API}/messages`, { token: a.token });
  const row = items(read).find((m) => m.target_ref?.id === post.id);
  assert.ok(row, '作者必须有一条指向该帖子的消息');
  assert.equal(row.reference_state, 'available', '公开可读的目标必须可跳转');
  assert.deepEqual(Object.keys(row).sort(), [
    'created_at',
    'id',
    'read_at',
    'reference_state',
    'revision',
    'target_ref',
    'type',
  ], '消息投影不得因接线新增任何字段（不泄露原因/标题/正文）');
});

test('G4-2 同形：不存在 / 已删除 / 不可核验类型 ⇒ 一律 unavailable，且三者逐字同形', async () => {
  const { h, a, b } = await harnessWithInbox();
  const live = await h.service.createPost(a.actor, postInput(), { idempotencyKey: idem(2) });
  const doomed = await h.service.createPost(a.actor, { ...postInput(), title: '将被删除的目标' }, { idempotencyKey: idem(3) });
  // 让 doomed 也有一条指向它的消息（他人评论 ⇒ 帖子作者收件箱）；再删除目标本身。
  await h.service.createComment(b.actor, doomed.id, { body: '占位：这条评论只为产生一条指向 doomed 的消息' }, {
    idempotencyKey: idem(4),
    ifMatch: '"1"',
  });
  await h.service.deletePost(a.actor, doomed.id, { idempotencyKey: idem(5), ifMatch: '"1"' });

  const missing = randomUUID();
  await seedMessage(h, a.userId, { type: 'post', id: missing, revision: 1 }, 'missing');
  await seedMessage(h, a.userId, { type: 'conversation', id: randomUUID(), revision: 1 }, 'unverifiable');

  const read = await h.inject('GET', `${API}/messages`, { token: a.token });
  const rows = items(read);
  const liveRow = rows.find((m) => m.target_ref?.id === live.id);
  const deletedRow = rows.find((m) => m.target_ref?.id === doomed.id);
  const missingRow = rows.find((m) => m.target_ref?.id === missing);
  const unverifiableRow = rows.find((m) => m.type === 'system' && m.target_ref?.type === 'conversation');
  for (const [label, row] of [['live', liveRow], ['deleted', deletedRow], ['missing', missingRow], ['unverifiable', unverifiableRow]]) {
    assert.ok(row, `${label} 行必须存在`);
  }

  assert.equal(liveRow.reference_state, 'available');
  // 三种"读不到"必须逐字同形：同一个字符串、同一组键 ⇒ 无法据此逆推目标状态。
  for (const [label, row] of [['已删除', deletedRow], ['不存在', missingRow], ['不可核验类型', unverifiableRow]]) {
    assert.equal(row.reference_state, 'unavailable', `${label} 必须 unavailable`);
    assert.deepEqual(Object.keys(row).sort(), Object.keys(liveRow).sort(), `${label} 行的字段集合同形`);
  }
  assert.equal(
    new Set([deletedRow.reference_state, missingRow.reference_state, unverifiableRow.reference_state]).size,
    1,
    '三种"读不到"必须收敛到同一个取值（不得区分隐藏与不存在）',
  );
  // 响应体里不得出现任何可区分原因的字样。
  assert.doesNotMatch(JSON.stringify(read.body), /unavailable_reason|hidden|deleted_at|not_found/i);
});

test('G4-3 动态：同一条消息、同一 id，删除前 available → 删除后 unavailable（读取时重查）', async () => {
  const { h, a, b } = await harnessWithInbox();
  const post = await h.service.createPost(a.actor, postInput(), { idempotencyKey: idem(6) });
  await h.service.createComment(b.actor, post.id, { body: '产生一条指向该帖子的消息' }, { idempotencyKey: idem(7), ifMatch: '"1"' });

  const before = await h.inject('GET', `${API}/messages`, { token: a.token });
  const msg = items(before).find((m) => m.target_ref?.id === post.id);
  assert.equal(msg.reference_state, 'available');

  await h.service.deletePost(a.actor, post.id, { idempotencyKey: idem(8), ifMatch: '"1"' });

  const after = await h.inject('GET', `${API}/messages`, { token: a.token });
  const same = items(after).find((m) => m.id === msg.id);
  assert.ok(same, '消息本身不得因目标删除而消失（历史仍在，只是点不动）');
  assert.equal(same.reference_state, 'unavailable', '目标删除后同一 id 必须变 unavailable');
  assert.equal(same.revision, msg.revision, 'reference_state 变化不得推进消息自身的 revision');
});

test('G4-4 不越权：只接线不动路由；社区域只暴露一个只读谓词', async () => {
  const { h } = await harnessWithInbox();
  // 社区域对外成员：`visibility` 只含一个函数，没有第二只读成员、没有 id 到正文的通道。
  const service = h.app.communityService;
  assert.deepEqual(Object.keys(service.visibility), ['isPubliclyVisible']);
  assert.equal(typeof service.visibility.isPubliclyVisible, 'function');

  // 该谓词不得外溢到任何路由/契约面（它只服务消息域内部端口）。
  // 注意：`isPubliclyVisible` 这个**名字**在知识域后台读面里早已存在（`routes/knowledge.ts` 用的是
  // `AdminPublicView`，与本谓词无关）；这里禁的是**社区服务上的那个成员**被路由引用。
  const routesDir = `${SRC_ROOT}routes/`;
  const offenders = readdirSync(routesDir)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => /communityService[\s\S]{0,40}\.visibility\b|\.visibility\.isPubliclyVisible/.test(readFileSync(`${routesDir}${name}`, 'utf8')));
  assert.deepEqual(offenders, [], '社区可见性谓词不得出现在任何路由文件里');
});

test('G4-5 fail-closed：未接线（社区服务为 null）时一律 unavailable，且不抛 5xx', async () => {
  // 直接对端口下单测：没有社区判据 ⇒ 一律 unavailable（装配层漏赋值时的真实后果）。
  const { createCommunityReferencePort } = await import('../../services/api/src/messages/reference-community.ts');
  const port = createCommunityReferencePort({ community: () => null });
  assert.equal(port.kind, 'wired');
  for (const target of [
    { type: 'post', id: randomUUID(), revision: 1 },
    { type: 'conversation', id: randomUUID(), revision: 1 },
  ]) {
    assert.equal(await port.stateOf({ target_ref: target, userId: randomUUID() }), 'unavailable');
  }
  // 判据抛错也必须折叠成 unavailable（不把目标侧细节带出去）。
  const throwing = createCommunityReferencePort({
    community: () => ({
      isPubliclyVisible: () => {
        throw new Error('目标侧炸了：细节不得外传');
      },
    }),
  });
  assert.equal(await throwing.stateOf({ target_ref: { type: 'post', id: randomUUID(), revision: 1 }, userId: 'u' }), 'unavailable');
});

// 供上面用例自检：源码根必须真实存在（防止路径写错导致"扫描 0 命中"的假绿）。
test('G4-0 自检：源码根可读（防扫描路径写错造成假绿）', () => {
  assert.ok(readdirSync(`${SRC_ROOT}routes/`).length > 10);
  assert.ok(fileURLToPath(new URL('../../services/api/src/app.ts', import.meta.url)).includes('app.ts'));
});
