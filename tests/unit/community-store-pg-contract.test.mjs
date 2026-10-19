/**
 * GY-I15（#15）切片 C1 · 社区域 PostgreSQL store 的**语句形状契约**（不连真库）。
 *
 * 这里不读源码文本猜实现，而是用**记录型假池**逐条抓 `(text, values)`，用语句形状反证派单
 * §四.2 / §四.3 的四条硬约束：
 *   1. **幂等点赞**：重复 PUT 只能由唯一键 `(user_id, target_type, target_id)` 裁决 ——
 *      `INSERT ... ON CONFLICT ... DO NOTHING RETURNING`，⛔ 不许先 SELECT 再 INSERT；
 *      计数必须是派生 `count(*)`（没有计数器列的读改写）。
 *   2. **CAS 式状态流转**：`commitPostIfCurrent` / `commitCommentIfCurrent` 必须在**同一事务**
 *      内 `SELECT ... FOR UPDATE` → 逐项比较 → `UPDATE`；失败路径**一条 UPDATE 都不许发**，
 *      且失败原因的**判定顺序**与内存实现逐条一致（删除是单向门，先于归属判定）。
 *   3. **读取时重查可见性**：`getPost` / `getComment` / `getModeration` / `listPosts` 每次都
 *      真发查询（没有跨请求缓存，隐藏/失效不得因缓存复活）。
 *   4. **并发重复插入返回 duplicate**：`insertPost` / `insertComment` 冲突（0 行）⇒ `false`，
 *      且**不写**审核结论（内容与结论同一次提交，与内存实现顺序一致）。
 * 另加：错误折叠（57014/55P03 ⇒ `PROVIDER_TIMEOUT`）、闭集行映射（未知值不静默降级）、
 * 幂等台账三步各是**一条**带条件的语句。
 *
 * 真库行为（唯一约束、并发收敛、外键、迁移 apply/rollback）见 `tests/integration/community-pg.mjs`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../../services/api/src/errors.ts';
import {
  classifyCommunityDatabaseError,
  commentRecordFromRow,
  createPostgresCommunityStore,
  moderationRecordFromRow,
  postRecordFromRow,
  reportRecordFromRow,
} from '../../services/api/src/community/store-pg.ts';

const POST_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const COMMENT_ID = 'cccccccc-1111-4111-8111-111111111111';
const REPORT_ID = 'dddddddd-1111-4111-8111-111111111111';
const MODERATION_ID = 'eeeeeeee-1111-4111-8111-111111111111';
const AUTHOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = '2026-10-18T02:00:00.000Z';
const UPDATED_AT = '2026-10-18T02:30:00.000Z';
const DIGEST = 'a'.repeat(64);
const KEY_HASH = 'ab'.repeat(32);
const SCOPE = `${AUTHOR}\nPUT\n/posts/${POST_ID}/like`;

const BEGIN = 'BEGIN';
const COMMIT = 'COMMIT';
const LOCK = "SET LOCAL lock_timeout = '4s'";

/** 事务控制语句由假池自动应答（不进脚本）：脚本因此 1:1 对应**业务**语句。 */
const TRANSACTION_CONTROL = new Set([BEGIN, COMMIT, 'ROLLBACK', LOCK]);

/** 抹平缩进换行，断言不被排版牵着走。 */
const flat = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * 记录型假池：`script[i]` 是第 i 条**业务**语句的回答（行数组 / 函数 / Error）。
 * 事务控制语句（BEGIN / SET LOCAL / COMMIT / ROLLBACK）自动返回空行，但仍被记录，
 * 因此"事务里到底发了几条语句"照样可断言。脚本用尽即抛 ⇒ 任何"多查了一次"的实现会立刻炸。
 */
function fakePool(script = []) {
  const calls = [];
  let index = 0;
  const handle = async (text, values) => {
    calls.push({ text, values });
    if (TRANSACTION_CONTROL.has(flat(text))) return { rows: [] };
    const step = script[index];
    index += 1;
    if (step === undefined) {
      throw new Error(`假池脚本已用尽（第 ${index} 条业务语句）：${flat(text)}`);
    }
    const response = typeof step === 'function' ? step({ text, values }) : step;
    if (response instanceof Error) throw response;
    return { rows: response };
  };
  return {
    calls,
    query: handle,
    async connect() {
      return { query: handle, release() {} };
    },
    /** 全部语句（含事务控制），抹平空白。 */
    statements: () => calls.map((call) => flat(call.text)),
    /** 仅业务语句（去掉事务控制），抹平空白。 */
    business: () => calls.map((call) => flat(call.text)).filter((sql) => !TRANSACTION_CONTROL.has(sql)),
    businessCalls: () => calls.filter((call) => !TRANSACTION_CONTROL.has(flat(call.text))),
  };
}

/** 与 `pg` 返回同形的行（timestamptz 给 Date，jsonb 给已解析的数组）。 */
const postRow = (overrides = {}) => ({
  id: POST_ID,
  revision: 1,
  author_id: AUTHOR,
  title: '春小麦除草',
  body: '正文',
  crop_id: 'crop-1',
  region_code: '330100',
  media_ids: [],
  linked_knowledge_type: null,
  linked_knowledge_id: null,
  linked_knowledge_revision: null,
  visibility: 'published',
  audit_state: 'approved',
  created_at: new Date(CREATED_AT),
  updated_at: new Date(UPDATED_AT),
  ...overrides,
});

const postRecord = (overrides = {}) => ({
  id: POST_ID,
  revision: 1,
  author_id: AUTHOR,
  title: '春小麦除草',
  body: '正文',
  crop_id: 'crop-1',
  region_code: '330100',
  media_ids: [],
  linked_knowledge_ref: null,
  visibility: 'published',
  audit_state: 'approved',
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
  ...overrides,
});

const commentRow = (overrides = {}) => ({
  id: COMMENT_ID,
  revision: 1,
  post_id: POST_ID,
  author_id: AUTHOR,
  body: '评论正文',
  visibility: 'published',
  audit_state: 'approved',
  created_at: new Date(CREATED_AT),
  ...overrides,
});

const commentRecord = (overrides = {}) => ({
  id: COMMENT_ID,
  revision: 1,
  post_id: POST_ID,
  author_id: AUTHOR,
  body: '评论正文',
  visibility: 'published',
  audit_state: 'approved',
  created_at: CREATED_AT,
  ...overrides,
});

const moderationRecord = (overrides = {}) => ({
  id: MODERATION_ID,
  target_ref: { type: 'post', id: POST_ID, revision: 1 },
  decision: 'approved',
  reason_codes: [],
  hard_rule_passed: true,
  rule_version: 'rules-1',
  text_digest: DIGEST,
  contract_complete: false,
  missing_contract_fields: ['model_version', 'prompt_version'],
  created_at: CREATED_AT,
  ...overrides,
});

const moderationRow = (overrides = {}) => ({
  id: MODERATION_ID,
  target_type: 'post',
  target_id: POST_ID,
  target_revision: 1,
  decision: 'approved',
  reason_codes: [],
  hard_rule_passed: true,
  rule_version: 'rules-1',
  text_digest: DIGEST,
  contract_complete: false,
  missing_contract_fields: ['model_version', 'prompt_version'],
  created_at: new Date(CREATED_AT),
  ...overrides,
});

const storeWith = (pool) => createPostgresCommunityStore({ pool, settlePollMs: 1 });

test('store 声明自己是持久化实现（app.ts 用这个标志决定 real 是否放行）', () => {
  const store = storeWith(fakePool());
  assert.equal(store.persistent, true);
});

// ---------------------------------------------------------------------------
// 1. 插入：内容与结论同一次事务；冲突只由主键裁决
// ---------------------------------------------------------------------------

test('insertPost：一条 INSERT ... ON CONFLICT DO NOTHING RETURNING + 一条结论 upsert，包在同一事务里', async () => {
  const pool = fakePool([[{ id: POST_ID }], []]);
  const store = storeWith(pool);

  const inserted = await store.insertPost(postRecord(), moderationRecord());

  assert.equal(inserted, true);
  const sql = pool.statements();
  assert.deepEqual([sql[0], sql[1]], [BEGIN, LOCK], 'CAS/多语句写必须显式开事务并设锁超时');
  assert.equal(sql[sql.length - 1], COMMIT);
  const business = pool.business();
  assert.equal(business.length, 2, '内容行 + 结论，恰好两条业务语句');
  assert.equal(business[0].startsWith('INSERT INTO community_posts'), true);
  assert.equal(business[0].includes('ON CONFLICT (id) DO NOTHING RETURNING id'), true, '重复判定必须交给主键');
  assert.equal(/select/i.test(business[0]), false, '写入前不许先查');
  assert.equal(business[1].startsWith('INSERT INTO community_moderation_decisions'), true);
  assert.equal(business[1].includes('ON CONFLICT (target_type, target_id, target_revision) DO UPDATE'), true,
    '提交路径的结论写入与内存实现的 Map.set 同义（同键覆盖）');

  const values = pool.businessCalls()[0].values;
  assert.equal(values.length, 15);
  assert.equal(values[0], POST_ID);
  assert.equal(values[1], AUTHOR);
  assert.equal(values[7] instanceof Array, true, 'media_ids 以文本数组传，形状不被驱动改写');
  assert.deepEqual(values[7], []);
  assert.equal(values[8], null, '无知识关联时三列全 NULL（CHECK 要求同空/同有）');
  const moderationValues = pool.businessCalls()[1].values;
  assert.equal(moderationValues[0], 'post', '结论键取自内容行（与内存实现一致）');
  assert.equal(moderationValues[1], POST_ID);
  assert.equal(moderationValues[2], 1);
  assert.equal(moderationValues[5], JSON.stringify([]), 'jsonb 数组按文本传');
});

test('insertPost：主键冲突（0 行）⇒ false，且**不写**结论（不消耗第三条语句）', async () => {
  const pool = fakePool([[]]);
  const store = storeWith(pool);

  assert.equal(await store.insertPost(postRecord(), moderationRecord()), false);
  assert.equal(pool.business().length, 1, '内容没写进去就不许写结论');
});

test('insertComment：先在事务内校验父帖（FOR SHARE），再插评论，最后写结论', async () => {
  const pool = fakePool([[{ visibility: 'published', revision: 1 }], [{ id: COMMENT_ID }], []]);
  const store = storeWith(pool);

  const inserted = await store.insertComment(commentRecord(), moderationRecord({
    target_ref: { type: 'comment', id: COMMENT_ID, revision: 1 },
  }), { id: POST_ID, revision: 1 });

  assert.equal(inserted, true);
  const business = pool.business();
  assert.equal(business.length, 3);
  assert.equal(business[0].includes('FROM community_posts'), true);
  assert.equal(business[0].includes('FOR SHARE'), true, '父帖校验必须与插入同临界区');
  assert.equal(business[1].startsWith('INSERT INTO community_comments'), true);
  assert.equal(business[2].startsWith('INSERT INTO community_moderation_decisions'), true);
});

test('insertComment：父帖已删除 / revision 不符 / 不存在 ⇒ false，且一条 INSERT 都不发', async () => {
  for (const parentRow of [[{ visibility: 'deleted', revision: 1 }], [{ visibility: 'published', revision: 9 }], []]) {
    const pool = fakePool([parentRow]);
    const store = storeWith(pool);
    assert.equal(
      await store.insertComment(commentRecord(), null, { id: POST_ID, revision: 1 }),
      false,
      `父帖形状 ${JSON.stringify(parentRow)} 必须拒绝插入`,
    );
    assert.equal(pool.business().length, 1, '拒绝路径只有父帖校验这一条语句');
  }
});

// ---------------------------------------------------------------------------
// 2. CAS 状态流转：同序判定 + 失败路径不发 UPDATE
// ---------------------------------------------------------------------------

test('commitPostIfCurrent：FOR UPDATE → UPDATE → 结论 upsert，补丁不含 revision 时不动 revision', async () => {
  const pool = fakePool([[postRow()], [], []]);
  const store = storeWith(pool);

  const result = await store.commitPostIfCurrent(
    POST_ID,
    { revision: 1, author_id: AUTHOR, visibility: 'published', audit_state: 'approved' },
    { visibility: 'deleted', updated_at: UPDATED_AT },
    moderationRecord({ decision: 'rejected' }),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.record.revision, 1, '删除只改 visibility/updated_at，不升 revision');
    assert.equal(result.record.visibility, 'deleted');
  }
  const sql = pool.statements();
  assert.deepEqual([sql[0], sql[1]], [BEGIN, LOCK]);
  assert.equal(sql[sql.length - 1], COMMIT);
  const business = pool.business();
  assert.equal(business[0].includes('WHERE id = $1::uuid FOR UPDATE'), true, 'CAS 必须先锁行再比较');
  assert.equal(business[1].startsWith('UPDATE community_posts'), true);
  assert.equal(business[2].startsWith('INSERT INTO community_moderation_decisions'), true);
  assert.equal(pool.businessCalls()[2].values[2], 1, '结论键 = 写入后的 revision');
  assert.equal(pool.businessCalls()[1].values[1], 1, 'UPDATE 里 revision 仍是 1');
});

test('commitPostIfCurrent：成功升级 revision 时结论键跟着新 revision', async () => {
  const pool = fakePool([[postRow()], [], []]);
  const store = storeWith(pool);

  await store.commitPostIfCurrent(
    POST_ID,
    { revision: 1, author_id: AUTHOR },
    { revision: 2, title: '改过的标题', updated_at: UPDATED_AT },
    moderationRecord({ target_ref: { type: 'post', id: POST_ID, revision: 2 } }),
  );

  const values = pool.businessCalls()[2].values;
  assert.equal(values[2], 2, '结论必须绑定到新 revision');
});

test('commitPostIfCurrent：判定顺序逐条对齐内存实现（删除 → 归属 → revision → 可见性 → 审核状态）', async () => {
  const cases = [
    { row: [], expected: { revision: 1, author_id: AUTHOR }, reason: 'NOT_FOUND' },
    // 已删除是单向门：即使作者与 revision 都不符，也只能报 DELETED。
    { row: [postRow({ visibility: 'deleted' })], expected: { revision: 9, author_id: OTHER }, reason: 'DELETED' },
    { row: [postRow()], expected: { revision: 9, author_id: OTHER }, reason: 'AUTHOR_CHANGED' },
    { row: [postRow()], expected: { revision: 9, author_id: AUTHOR }, reason: 'REVISION_CHANGED' },
    {
      row: [postRow()],
      expected: { revision: 1, author_id: AUTHOR, visibility: 'private' },
      reason: 'VISIBILITY_CHANGED',
    },
    {
      row: [postRow()],
      expected: { revision: 1, author_id: AUTHOR, audit_state: 'pending' },
      reason: 'AUDIT_STATE_CHANGED',
    },
  ];
  for (const item of cases) {
    const pool = fakePool([item.row]);
    const store = storeWith(pool);
    const result = await store.commitPostIfCurrent(POST_ID, item.expected, { visibility: 'hidden' }, null);
    assert.deepEqual(result, { ok: false, reason: item.reason }, `${item.reason} 的顺序必须与内存实现一致`);
    assert.equal(pool.business().length, 1, `${item.reason} 路径不许发 UPDATE，也不许写结论`);
    assert.equal(pool.statements().at(-1), COMMIT, '失败路径也要正常关事务');
  }
});

test('commitCommentIfCurrent：同序判定与补丁白名单（revision/body/visibility/audit_state）', async () => {
  const pool = fakePool([[commentRow()], [], []]);
  const store = storeWith(pool);

  const result = await store.commitCommentIfCurrent(
    COMMENT_ID,
    { revision: 1, author_id: AUTHOR, visibility: 'published' },
    { revision: 2, body: '改过的评论', visibility: 'hidden', audit_state: 'pending' },
    moderationRecord({ target_ref: { type: 'comment', id: COMMENT_ID, revision: 2 } }),
  );

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.record.body, '改过的评论');
  const business = pool.business();
  assert.equal(business[0].includes('FROM community_comments'), true);
  assert.equal(business[0].includes('FOR UPDATE'), true);
  assert.equal(business[1].startsWith('UPDATE community_comments'), true);

  const deleted = fakePool([[commentRow({ visibility: 'deleted' })]]);
  const deletedStore = storeWith(deleted);
  assert.deepEqual(
    await deletedStore.commitCommentIfCurrent(COMMENT_ID, { revision: 1 }, { visibility: 'published' }, null),
    { ok: false, reason: 'DELETED' },
  );
});

// ---------------------------------------------------------------------------
// 3. 读取时重查可见性：没有缓存
// ---------------------------------------------------------------------------

test('读取路径每次都真查询（无跨请求缓存）：同一 id 读两次就是两条 SELECT', async () => {
  const pool = fakePool([[postRow()], [postRow({ visibility: 'hidden' })]]);
  const store = storeWith(pool);

  const first = await store.getPost(POST_ID);
  const second = await store.getPost(POST_ID);

  assert.equal(first?.visibility, 'published');
  assert.equal(second?.visibility, 'hidden', '隐藏后必须当场反映，不能因缓存复活');
  assert.equal(pool.business().length, 2);
  for (const sql of pool.business()) {
    assert.equal(sql.startsWith('SELECT'), true);
    assert.equal(sql.includes('WHERE id = $1::uuid'), true);
  }
});

test('getModeration 每次现查，并按 (target_type, target_id, target_revision) 三元谓词定位', async () => {
  const pool = fakePool([[moderationRow()], []]);
  const store = storeWith(pool);

  assert.equal((await store.getModeration('post', POST_ID, 1))?.decision, 'approved');
  assert.equal(await store.getModeration('post', POST_ID, 1), null, '结论被清掉后不得复用上一次结果');

  for (const call of pool.businessCalls()) {
    assert.equal(
      call.text.replace(/\s+/g, ' ').includes(
        'WHERE target_type = $1::text AND target_id = $2::uuid AND target_revision = $3',
      ),
      true,
      '按对象查可见性必须走主键三元组',
    );
    assert.deepEqual(call.values, ['post', POST_ID, 1]);
  }
});

test('listPosts / listComments 把排序下推到 SQL（与内存实现的比较器同义）', async () => {
  const pool = fakePool([[postRow(), postRow({ id: COMMENT_ID })] , [commentRow()]]);
  const store = storeWith(pool);

  await store.listPosts();
  await store.listComments(POST_ID);

  const business = pool.business();
  assert.equal(business[0].includes('ORDER BY created_at DESC, id DESC'), true);
  assert.equal(business[1].includes('WHERE post_id = $1::uuid'), true);
  assert.equal(business[1].includes('ORDER BY created_at ASC, id ASC'), true);
});

// ---------------------------------------------------------------------------
// 4. 幂等点赞（集合语义，计数派生）
// ---------------------------------------------------------------------------

test('addLike：单条 INSERT ... ON CONFLICT DO NOTHING RETURNING；重复点赞返回 false（不重复计数）', async () => {
  const pool = fakePool([[{ target_id: POST_ID }], []]);
  const store = storeWith(pool);

  assert.equal(await store.addLike('post', POST_ID, AUTHOR), true);
  assert.equal(await store.addLike('post', POST_ID, AUTHOR), false, '重复 PUT 必须是 no-op');

  for (const call of pool.businessCalls()) {
    const sql = call.text.replace(/\s+/g, ' ');
    assert.equal(sql.includes('ON CONFLICT (user_id, target_type, target_id) DO NOTHING RETURNING target_id'), true);
    assert.equal(/select/i.test(sql), false, '幂等由唯一键裁决，不许先查');
    assert.deepEqual(call.values, ['post', POST_ID, AUTHOR]);
  }
});

test('removeLike：删除 0 行 ⇒ false；countLikes 是派生 count(*)，没有计数器列', async () => {
  const pool = fakePool([[], [{ count: 0 }]]);
  const store = storeWith(pool);

  assert.equal(await store.removeLike('comment', COMMENT_ID, AUTHOR), false);
  assert.equal(await store.countLikes('comment', COMMENT_ID), 0);

  const business = pool.business();
  assert.equal(business[0].startsWith('DELETE FROM community_likes'), true);
  assert.equal(business[0].includes('RETURNING target_id'), true, '要靠返回行数判定"是否真的取消了"');
  assert.equal(business[1].includes('count(*)::int'), true);
  assert.equal(/UPDATE/i.test(business.join(' ')), false, '点赞计数不许有读改写');
});

// ---------------------------------------------------------------------------
// 5. 未提交内容的结论补录 + 举报
// ---------------------------------------------------------------------------

test('putRefusalVerdict：单条语句同时判"已有结论"与"内容已提交"，0 行 ⇒ false（不覆盖首条）', async () => {
  const pool = fakePool([[{ target_id: POST_ID }], []]);
  const store = storeWith(pool);

  const record = moderationRecord({ decision: 'rejected', hard_rule_passed: false, rule_version: null });
  assert.equal(await store.putRefusalVerdict(record), true);
  assert.equal(await store.putRefusalVerdict(record), false);

  for (const call of pool.businessCalls()) {
    const sql = call.text.replace(/\s+/g, ' ');
    assert.equal(sql.startsWith('INSERT INTO community_moderation_decisions'), true);
    assert.equal(sql.includes('ON CONFLICT (target_type, target_id, target_revision) DO NOTHING'), true);
    assert.equal((sql.match(/NOT EXISTS/g) ?? []).length, 3, '三条判据：已有结论 + 帖子内容 + 评论内容');
    assert.equal(sql.includes("WHERE $1::text = 'post'"), true, '内容判据必须按 target_type 过滤');
    assert.equal(call.values[7], null, '模型层版本未取得就必须写 NULL，不填占位串');
  }
});

test('insertReport / getReport：按 id 覆盖（与 Map.set 同义），读回逐字段还原', async () => {
  const pool = fakePool([[], [{
    id: REPORT_ID,
    revision: 1,
    reporter_id: OTHER,
    target_type: 'post',
    target_id: POST_ID,
    target_revision: 3,
    state: 'received',
    reason_code: 'dangerous',
    detail: null,
    created_at: new Date(CREATED_AT),
  }]]);
  const store = storeWith(pool);

  await store.insertReport({
    id: REPORT_ID,
    revision: 1,
    reporter_id: OTHER,
    target_ref: { type: 'post', id: POST_ID, revision: 3 },
    state: 'received',
    reason_code: 'dangerous',
    detail: null,
    created_at: CREATED_AT,
  });
  const read = await store.getReport(REPORT_ID);

  assert.equal(pool.business()[0].includes('ON CONFLICT (id) DO UPDATE'), true);
  assert.deepEqual(read, {
    id: REPORT_ID,
    revision: 1,
    reporter_id: OTHER,
    target_ref: { type: 'post', id: POST_ID, revision: 3 },
    state: 'received',
    reason_code: 'dangerous',
    detail: null,
    created_at: CREATED_AT,
  });
});

// ---------------------------------------------------------------------------
// 6. 幂等台账：三步各一条带条件的语句
// ---------------------------------------------------------------------------

test('claimIdempotency：先清过期残留，再一条 ON CONFLICT DO NOTHING RETURNING（占位原子）', async () => {
  const pool = fakePool([[], [{ scope: SCOPE }], [], []]);
  const store = storeWith(pool);

  assert.equal(await store.claimIdempotency(SCOPE, KEY_HASH, {
    request_hash: 'rh-1',
    response_status: 201,
    expires_at: Date.parse(CREATED_AT),
  }), true);
  assert.equal(await store.claimIdempotency(SCOPE, KEY_HASH, {
    request_hash: 'rh-1',
    response_status: 201,
    expires_at: Date.parse(CREATED_AT),
  }), false);

  const business = pool.business();
  assert.equal(business[0].startsWith('DELETE FROM community_idempotency'), true, '先清过期占位');
  assert.equal(business[1].includes('ON CONFLICT (scope, key_hash) DO NOTHING RETURNING scope'), true);
  assert.equal(pool.businessCalls()[1].values[1], KEY_HASH, 'key_hash 以 hex 传入，SQL 里 decode');
  assert.equal(business[1].includes("decode($2, 'hex')"), true);
});

test('completeIdempotency / releaseIdempotency：都只作用于 outcome IS NULL 的行', async () => {
  const pool = fakePool([[{ scope: SCOPE }], [{ scope: SCOPE }]]);
  const store = storeWith(pool);

  assert.equal(await store.completeIdempotency(SCOPE, KEY_HASH, {
    response_status: 201,
    outcome: { kind: 'post', id: POST_ID, revision: 1 },
  }), true);
  await store.releaseIdempotency(SCOPE, KEY_HASH);

  const business = pool.business();
  assert.equal(business[0].startsWith('UPDATE community_idempotency'), true);
  assert.equal(business[0].includes('AND outcome IS NULL'), true);
  assert.equal(business[1].startsWith('DELETE FROM community_idempotency'), true);
  assert.equal(business[1].includes('AND outcome IS NULL'), true, '已完成的结果不因失败重试被抹掉');
});

test('findIdempotency：先清过期同键行再读；占位中（outcome NULL）视为不存在；settle 每次真读库', async () => {
  const pool = fakePool([
    [],
    [{ request_hash: 'rh-1', response_status: 201, outcome: null, expires_at_ms: 1 }],
    [{ outcome: null }],
    [{ outcome: { kind: 'post', id: POST_ID, revision: 1 } }],
  ]);
  const store = storeWith(pool);

  assert.equal(await store.findIdempotency(SCOPE, KEY_HASH), null);
  assert.equal(await store.awaitIdempotencySettled(SCOPE, KEY_HASH, 200), 'settled');
  assert.equal(pool.business().length, 4, '查询自带一次过期清理 + 一次 SELECT；轮询每次一条 SELECT（不是进程内 Map）');
  const business = pool.business();
  assert.equal(business[0].startsWith('DELETE FROM community_idempotency'), true, '过期行必须物理清掉，表不能只增不减');
  assert.equal(business[0].includes('AND expires_at <= now()'), true);
  assert.equal(business[1].startsWith('SELECT'), true);

  const done = fakePool([[{ outcome: null }]]);
  assert.equal(
    await storeWith(done).awaitIdempotencySettled(SCOPE, KEY_HASH, 0),
    'timeout',
    'waitMs 用尽必须如实返回 timeout',
  );
});

test('snapshotCounts：一条语句取四个真库计数', async () => {
  const pool = fakePool([[{ posts: 2, comments: 3, reports: 1, moderation: 4 }]]);
  const store = storeWith(pool);

  assert.deepEqual(await store.snapshotCounts(), { posts: 2, comments: 3, reports: 1, moderation: 4 });
  assert.equal(pool.business().length, 1);
});

// ---------------------------------------------------------------------------
// 7. 错误折叠与行映射
// ---------------------------------------------------------------------------

test('错误折叠：57014 / 55P03 ⇒ PROVIDER_TIMEOUT(retryable)，其余 ⇒ PROVIDER_UNAVAILABLE(retryable)', () => {
  for (const code of ['57014', '55P03']) {
    const error = Object.assign(new Error('x'), { code });
    const mapped = (() => {
      try {
        classifyCommunityDatabaseError(error);
      } catch (thrown) {
        return thrown;
      }
      return null;
    })();
    assert.equal(mapped?.code, 'PROVIDER_TIMEOUT', `${code} 必须折叠为超时`);
    assert.equal(mapped?.retryable, true);
  }
  const other = (() => {
    try {
      classifyCommunityDatabaseError(Object.assign(new Error('x'), { code: '22P02' }));
    } catch (thrown) {
      return thrown;
    }
    return null;
  })();
  assert.equal(other?.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(other?.retryable, true, '数据库暂不可用是可重试的瞬时故障');

  const passthrough = new ApiError('CONFLICT', '业务冲突');
  assert.throws(() => classifyCommunityDatabaseError(passthrough), (thrown) => thrown === passthrough);
});

test('行映射：闭集之外的值按内部不变式违反处理（不静默降级为可读）', () => {
  assert.throws(() => postRecordFromRow(postRow({ visibility: 'published_typo' })), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.throws(() => commentRecordFromRow(commentRow({ audit_state: 'ok' })), /契约闭集/);
  assert.throws(() => moderationRecordFromRow(moderationRow({ target_type: 'reply' })), /契约闭集/);
  assert.throws(() => reportRecordFromRow({
    id: REPORT_ID,
    revision: 1,
    reporter_id: OTHER,
    target_type: 'post',
    target_id: POST_ID,
    target_revision: 1,
    state: 'pending',
    reason_code: 'other',
    detail: null,
    created_at: new Date(CREATED_AT),
  }), /契约闭集/);
});

test('行映射：知识关联三列同空/同有、媒体引用还原为数组', () => {
  const linked = postRecordFromRow(postRow({
    media_ids: ['m1', 'm2'],
    linked_knowledge_type: 'species',
    linked_knowledge_id: 'spc-1',
    linked_knowledge_revision: 3,
  }));
  assert.deepEqual(linked.media_ids, ['m1', 'm2']);
  assert.deepEqual(linked.linked_knowledge_ref, { type: 'species', id: 'spc-1', revision: 3 });

  const bare = postRecordFromRow(postRow());
  assert.equal(bare.linked_knowledge_ref, null);

  assert.throws(() => postRecordFromRow(postRow({
    linked_knowledge_type: 'species',
    linked_knowledge_id: null,
    linked_knowledge_revision: null,
  })), /知识关联/);
});
