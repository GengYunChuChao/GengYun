// GY-I17（#17）· 消息域接真实 PostgreSQL 17.11 · 端到端证据（迁移 0019 + 并发 + 分页 + 归属）
//
// 运行（本机隔离集群，仅回环；库名硬钉，要求**空库**）：
//   createdb -h 127.0.0.1 -p <port> gengyun_messages_test
//   node tests/integration/messages-pg.mjs postgres://postgres@127.0.0.1:<port>/gengyun_messages_test
//
// 本脚本只讲一件事：**消息域的"未读→已读"是数据库里的一条原子 UPDATE 换来的**，因此
// 「同一未读消息被 20 个请求同时标记」只会推进一次版本；重复写由**唯一约束**判定（不是先查后写）；
// 未读数是**每次现算**的派生量（没有计数器列可漂移）；他人的消息与不存在的消息**同形**。
//
// 覆盖的读数（编号与派单 §2 对齐）：
//   [M] 迁移三连：清单结构不变量 ⇒ UP（表/索引/唯一约束/CHECK 出现）⇒ ROLLBACK（本片对象消失，
//       `users` 与 0008 的 `idempotency_keys` 逐字仍在）⇒ REPLAY（再出现）。
//   [D] 重复判定：同 (owner_id,event_key) 再写 ⇒ duplicate 且**行数不变**；同 id 再写 ⇒ 同样 duplicate。
//   [R] 标记已读：200、`revision` 1→2、`read_at` 非空、`ETag "2"`；再标记（新幂等键）⇒ 200 空操作，
//       `revision`/`read_at` 逐字不变；同幂等键重放 ⇒ 200 且读数不变（台账复用 0008）。
//   [N] 归属与同形：他人 token 读同一条 ⇒ 404；不存在的 id ⇒ 404；两者 `error.code`/`message` 逐字相同。
//   [C] 并发 20 条 PUT 同时标记同一未读消息 ⇒ 恰好 1 条 200、19 条 409；最终 `SELECT revision = 2`。
//   [U] `countUnread` 与逐行统计一致（HTTP 读数 = SQL 派生读数 = 列表内 `read_at IS NULL` 行数）。
//   [P] 分页：`limit=3` 游标翻页，id 序列与 SQL `ORDER BY created_at DESC, id DESC` 逐项相等，
//       无重复、无遗漏，末页 `next_cursor = null`。

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { createPostgresMessagesStore } from '../../services/api/src/messages/store-pg.ts';

const API = '/api/v1';
const DB = 'gengyun_messages_test';
const MIGRATION = '0019_messages_persistence.sql';
const DOWN = `migrations/rollback/${MIGRATION.replace(/\.sql$/, '.down.sql')}`;

const ownerUrl = new URL(process.argv[2] ?? `postgres://postgres@127.0.0.1:5432/${DB}`);
assert.equal(ownerUrl.hostname, '127.0.0.1', '本测试只允许回环地址');
assert.equal(ownerUrl.pathname, `/${DB}`, `库名必须硬钉为 ${DB}（防误连）`);

const notes = [];
function note(line) {
  notes.push(line);
  console.log(line);
}
const unread = (label, why) => note(`未取得 ${label}：${why}`);

const readSql = (rel) => readFileSync(new URL(`../../services/api/db/${rel}`, import.meta.url), 'utf8');
const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);

const owner = new pg.Client({ connectionString: ownerUrl.href });
/** 建过但未关闭的 app 实例：不关会让 node 进程挂着不退出。 */
const registeredApps = [];
await owner.connect();
const ownerPool = new pg.Pool({ connectionString: ownerUrl.href });
const seedStore = createPostgresAuthStore({ query: (text, params) => ownerPool.query(text, params) });

const q = async (text, params = []) => (await owner.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];
const countOf = async (text, params = []) => Number((await one(text, params)).v);

const subjectOf = (label) => randomBytes(32).toString('hex').replace(/^(.{56}).{8}$/, `$1${label.padStart(8, '0')}`);

async function launchApp() {
  const config = {
    ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    executionMode: 'real',
    sessionSigningKey: randomBytes(32).toString('hex'),
  };
  const app = buildApp({ config, pool: ownerPool, now: () => new Date() });
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

// ---------------------------------------------------------------------------
// [M] 迁移三连
// ---------------------------------------------------------------------------
async function migrationTriple() {
  const discovered = readdirSync(migrationsDir)
    .filter((name) => /^\d{4,}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const versions = discovered.map((name) => name.slice(0, 4));
  const numbers = versions.map((version) => Number(version));
  assert.equal(new Set(versions).size, versions.length, `迁移版本号重复：${versions.join(',')}`);
  for (let index = 1; index < numbers.length; index += 1) {
    assert.ok(numbers[index - 1] < numbers[index], `迁移版本号必须严格递增（现场：${versions.join(',')}）`);
  }
  assert.ok(discovered.includes(MIGRATION), `迁移清单必须含 ${MIGRATION}`);
  note(`[M] 迁移清单 ${discovered.length} 个，版本号无重复且严格递增，末项 ${versions[versions.length - 1]}`);

  const objects = async () => ({
    table: (await one("SELECT to_regclass('public.messages') AS v")).v,
    index: (await one("SELECT to_regclass('public.messages_owner_created_idx') AS v")).v,
    unique: await countOf("SELECT count(*)::int AS v FROM pg_constraint WHERE conname = 'messages_owner_event_key'"),
    checks: await countOf(
      "SELECT count(*)::int AS v FROM pg_constraint WHERE conrelid = to_regclass('public.messages') AND contype = 'c'",
    ),
    columns: await countOf(
      "SELECT count(*)::int AS v FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'messages'",
    ),
    ledger: (await one("SELECT to_regclass('public.idempotency_keys') AS v")).v,
    users: (await one("SELECT to_regclass('public.users') AS v")).v,
  });

  for (const name of discovered) {
    if (name === MIGRATION) continue;
    await owner.query(readSql(`migrations/${name}`));
  }
  assert.equal((await objects()).table, null, '应用其它迁移后，本片建的表必须还不存在（证明 UP 才是它出现的唯一原因）');

  // UP
  await owner.query(readSql(`migrations/${MIGRATION}`));
  let state = await objects();
  assert.equal(state.table, 'messages', 'UP 后 public.messages 必须存在');
  assert.equal(state.index, 'messages_owner_created_idx', 'UP 后列表索引必须在岗');
  assert.equal(state.unique, 1, '(owner_id, event_key) 唯一约束必须由数据库保证');
  assert.equal(state.checks, 4, '四个 CHECK 必须在岗（类型闭集/版本为正/事件键非空/目标引用为对象）');
  assert.equal(state.columns, 8, '列数锁定在契约明列的 8 列，不多不少');
  assert.ok(state.ledger, '0008 的幂等台账必须仍在（本片复用它，不另立表）');
  note('[M] UP：messages 表 / 列表索引 / (owner_id,event_key) 唯一约束 / 4 个 CHECK / 8 列 全部出现');

  // ROLLBACK
  await owner.query(readSql(DOWN));
  state = await objects();
  assert.equal(state.table, null, 'DOWN 后 public.messages 必须消失');
  assert.equal(state.index, null, 'DOWN 后列表索引必须消失');
  assert.equal(state.unique, 0, 'DOWN 后唯一约束必须消失（随表）');
  assert.ok(state.ledger, 'DOWN 不得触碰 0008 的幂等台账');
  assert.ok(state.users, 'DOWN 不得触碰 users');
  note('[M] ROLLBACK：本片对象全部消失，users 与 idempotency_keys 逐字仍在');

  // REPLAY
  await owner.query(readSql(`migrations/${MIGRATION}`));
  assert.equal((await objects()).table, 'messages', 'REPLAY 后必须再次出现（迁移可重放）');
  note('[M] REPLAY：同一份 UP 再执行一次仍然成功，messages 再次出现');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
try {
  const publicTables = await countOf(
    "SELECT count(*)::int AS v FROM pg_tables WHERE schemaname = 'public'",
  );
  assert.equal(publicTables, 0, `库 ${DB} 必须是空库（现场 public 表数 ${publicTables}）——请先 createdb 一个干净的库`);

  await migrationTriple();

  const { app, call } = await launchApp();
  assert.notEqual(app.messagesService, null, 'real + pool 下消息服务必须接线（否则 /messages 整域 503）');
  const service = app.messagesService;

  const userA = await seedStore.createUser(subjectOf('00002001'));
  const userB = await seedStore.createUser(subjectOf('00002002'));
  const tokenA = mintOpaqueToken();
  await seedStore.createSession({
    userId: userA.id,
    tokenHashHex: hashToken(tokenA),
    authEpoch: userA.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });
  const tokenB = mintOpaqueToken();
  await seedStore.createSession({
    userId: userB.id,
    tokenHashHex: hashToken(tokenB),
    authEpoch: userB.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });
  note(`[0] 用户 A ${userA.id} / 用户 B ${userB.id} 已在 users 表落库，会话走真实 PG`);

  const targetRef = { type: 'post', id: 'post-1', revision: 1 };
  const append = async (eventKey, overrides = {}) => {
    const result = await service.appendMessage({
      owner_id: userA.id,
      type: 'like',
      target_ref: targetRef,
      event_key: eventKey,
      ...overrides,
    });
    return result;
  };

  // ---- [D] 重复判定由唯一约束给出 ----
  const first = await append('like:post-1');
  assert.equal(first.created, true, '首次追加必须是 created=true');
  const repeated = await append('like:post-1');
  assert.equal(repeated.created, false, '同 (owner_id,event_key) 再写必须 created=false');
  assert.equal(repeated.message.id, first.message.id, '去重后返回的必须是同一条消息');
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.messages WHERE owner_id = $1 AND event_key = $2', [userA.id, 'like:post-1']),
    1,
    '重复写后行数必须仍是 1',
  );

  // 同 id 再写（主键冲突）也必须由数据库判定为 duplicate，而不是应用层先查。
  const rawStore = createPostgresMessagesStore({ pool: ownerPool });
  const duplicateById = await rawStore.insertMessage({
    id: first.message.id,
    revision: 1,
    owner_id: userA.id,
    type: 'like',
    target_ref: targetRef,
    read_at: null,
    created_at: first.message.created_at,
    event_key: 'like:post-1-other',
  });
  assert.equal(duplicateById, 'duplicate', '同 id 再写必须走唯一约束的 duplicate 分支');
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.messages WHERE owner_id = $1', [userA.id]),
    1,
    '两次重复写之后 A 仍只有 1 条消息',
  );
  note('[D] 同 (owner_id,event_key) 与同 id 两条重复路径都返回 duplicate，A 的行数始终 1');

  // ---- [R] 标记已读：单条 UPDATE 换来一次版本推进 ----
  const readKey = randomUUID();
  const readOne = await call(`${API}/messages/${first.message.id}/read`, {
    method: 'PUT',
    token: tokenA,
    headers: { 'idempotency-key': readKey, 'if-match': '"1"' },
  });
  assert.equal(readOne.status, 200, `首次标记已读必须 200（现场 ${readOne.status}：${readOne.text}）`);
  assert.equal(readOne.body.data.revision, 2, '首次标记已读必须推进一版');
  assert.equal(typeof readOne.body.data.read_at, 'string', '标记后 read_at 必须非空');
  assert.equal(readOne.etag, '"2"', 'ETag 必须跟着新版本走');
  const afterFirstRead = await q(
    'SELECT revision, read_at FROM public.messages WHERE id = $1 AND owner_id = $2',
    [first.message.id, userA.id],
  );
  assert.equal(afterFirstRead[0].revision, 2);
  assert.notEqual(afterFirstRead[0].read_at, null);

  const noopRead = await call(`${API}/messages/${first.message.id}/read`, {
    method: 'PUT',
    token: tokenA,
    headers: { 'idempotency-key': randomUUID(), 'if-match': '"2"' },
  });
  assert.equal(noopRead.status, 200, `再次标记已读必须 200 空操作（现场 ${noopRead.status}：${noopRead.text}）`);
  assert.equal(noopRead.body.data.revision, 2, '空操作不得再推进版本');
  const afterNoop = await q(
    'SELECT revision, read_at FROM public.messages WHERE id = $1 AND owner_id = $2',
    [first.message.id, userA.id],
  );
  assert.equal(afterNoop[0].revision, 2, '空操作后版本不变');
  assert.deepEqual(afterNoop[0].read_at, afterFirstRead[0].read_at, '空操作后 read_at 逐字不变');

  const replayRead = await call(`${API}/messages/${first.message.id}/read`, {
    method: 'PUT',
    token: tokenA,
    headers: { 'idempotency-key': readKey, 'if-match': '"1"' },
  });
  assert.equal(replayRead.status, 200, `同幂等键重放必须 200（现场 ${replayRead.status}：${replayRead.text}）`);
  assert.equal(replayRead.body.data.revision, 2, '重放回放的是首次结果，版本仍是 2');
  note('[R] 首次标记 200/revision=2/read_at 非空；再次标记 200 空操作（revision、read_at 不变）；同幂等键重放 200');

  // ---- [N] 他人消息与不存在同形 ----
  const foreign = await call(`${API}/messages/${first.message.id}/read`, {
    method: 'PUT',
    token: tokenB,
    headers: { 'idempotency-key': randomUUID(), 'if-match': '"1"' },
  });
  assert.equal(foreign.status, 404, `他人消息必须 404（现场 ${foreign.status}）`);
  const missing = await call(`${API}/messages/${randomUUID()}/read`, {
    method: 'PUT',
    token: tokenB,
    headers: { 'idempotency-key': randomUUID(), 'if-match': '"1"' },
  });
  assert.equal(missing.status, 404, '不存在的 id 必须 404');
  assert.deepEqual(
    { code: foreign.body.error.code, message: foreign.body.error.message },
    { code: missing.body.error.code, message: missing.body.error.message },
    '他人消息与不存在必须同形（同一 code、同一 message）',
  );
  const listB = await call(`${API}/messages`, { token: tokenB });
  assert.equal(listB.status, 200);
  assert.equal(listB.body.data.items.length, 0, 'B 的列表里不得出现 A 的消息');
  note(`[N] 他人消息与不存在同形：${foreign.body.error.code} / 404，B 的列表为 0 条`);

  // ---- [C] 并发 20 条同时标记同一条未读消息 ----
  const concurrent = await append('like:post-concurrent');
  assert.equal(concurrent.created, true);
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      call(`${API}/messages/${concurrent.message.id}/read`, {
        method: 'PUT',
        token: tokenA,
        headers: { 'idempotency-key': randomUUID(), 'if-match': '"1"' },
      }),
    ),
  );
  const ok = results.filter((result) => result.status === 200);
  const conflicts = results.filter((result) => result.status === 409);
  assert.equal(ok.length, 1, `并发标记必须只有 1 次成功（现场 200×${ok.length}、409×${conflicts.length}）`);
  assert.equal(conflicts.length, 19, '其余 19 条必须因版本或已读冲突被拒');
  for (const conflict of conflicts) {
    assert.equal(conflict.body.error.code, 'REVISION_CONFLICT', `并发拒绝的 code 必须是 REVISION_CONFLICT（现场 ${conflict.body.error.code}）`);
  }
  const afterConcurrent = await q(
    'SELECT revision, read_at FROM public.messages WHERE id = $1 AND owner_id = $2',
    [concurrent.message.id, userA.id],
  );
  assert.equal(afterConcurrent[0].revision, 2, '并发收敛后版本必须是 2（只推进一次）');
  assert.notEqual(afterConcurrent[0].read_at, null);
  note(`[C] 并发 20 → 200×1 / 409×19；最终 SELECT revision = ${afterConcurrent[0].revision}，read_at 非空`);

  // ---- 造 7 条消息用于分页与未读统计 ----
  for (let index = 0; index < 7; index += 1) {
    const created = await append(`like:post-page-${index}`);
    assert.equal(created.created, true);
  }
  const total = await countOf('SELECT count(*)::int AS v FROM public.messages WHERE owner_id = $1', [userA.id]);
  assert.equal(total, 9, `A 应有 9 条消息（1 条去重锚点 + 1 条并发锚点 + 7 条分页样本；现场 ${total}）`);

  // ---- [U] countUnread 是派生量，与逐行统计一致 ----
  const unreadRows = await q(
    'SELECT read_at FROM public.messages WHERE owner_id = $1',
    [userA.id],
  );
  const perRowUnread = unreadRows.filter((row) => row.read_at === null).length;
  const unreadCount = await call(`${API}/messages/unread-count`, { token: tokenA });
  assert.equal(unreadCount.status, 200);
  assert.equal(unreadCount.body.data.count, perRowUnread, 'HTTP 未读数必须等于逐行统计');
  const listAll = await call(`${API}/messages?limit=50`, { token: tokenA });
  assert.equal(listAll.status, 200);
  assert.equal(
    listAll.body.data.items.filter((item) => item.read_at === null).length,
    perRowUnread,
    '列表内 read_at IS NULL 的行数必须与未读数一致',
  );
  note(`[U] countUnread=${unreadCount.body.data.count} = 逐行统计=${perRowUnread} = 列表未读行数，三处一致`);

  // ---- [P] 分页：无重复、无遗漏、顺序与 SQL 一致 ----
  const expectedIds = (
    await q('SELECT id FROM public.messages WHERE owner_id = $1 ORDER BY created_at DESC, id DESC', [userA.id])
  ).map((row) => row.id);
  const collected = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await call(`${API}/messages?limit=3${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, { token: tokenA });
    assert.equal(page.status, 200, `翻页请求必须 200（现场 ${page.status}：${page.text}）`);
    pages += 1;
    assert.ok(pages <= 10, '翻页次数异常（可能游标不前进）');
    for (const item of page.body.data.items) collected.push(item.id);
    cursor = page.body.data.next_cursor;
    if (cursor !== null) assert.equal(typeof cursor, 'string');
  } while (cursor !== null);
  assert.equal(pages, 3, `9 条 / limit=3 必须翻 3 页（现场 ${pages}）`);
  assert.deepEqual(collected, expectedIds, '翻页收集的 id 序列必须与 SQL 排序逐项相等');
  assert.equal(new Set(collected).size, collected.length, '翻页不得出现重复');
  assert.equal(collected.length, total, '翻页不得遗漏');
  assert.equal(cursor, null, '末页 next_cursor 必须是 null');
  note(`[P] limit=3 翻 ${pages} 页，id 序列与 SQL (created_at DESC, id DESC) 逐项相等，无重复无遗漏`);

  note('[√] ALL PASS：消息域 PostgreSQL 持久化端到端（迁移/重复/已读/归属/并发/派生计数/分页）');
} finally {
  for (const instance of registeredApps) await instance.close().catch(() => {});
  await ownerPool.end().catch(() => {});
  await owner.end().catch(() => {});
}

unread('真机（微信端）读数', '本片只覆盖后端 HTTP 契约，客户端未改也未在真机跑');
unread('后台推送（写消息的调用方）', '消息写入仍由服务内部 appendMessage 驱动，本片不接线推送通道');
unread('>1 万行规模', '本片用 9 条消息验证语义与游标，未做万行级基准');
unread('跨库恢复演练', '本片只验证单库内迁移 UP/ROLLBACK/REPLAY，未做备份恢复演练');
