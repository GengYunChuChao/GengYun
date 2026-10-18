/**
 * GY-I18（#18）T-R12-03 · 后台账号读面接真实目录 · 单元回归（真库口径见
 * `tests/integration/admin-accounts-read-pg.mjs`，本文件全部用内存假实现）。
 *
 * 本文件只钉三件事：
 *  1. **能力对象存在 ⇒ 读面放行**：注入目录后 `listAdminUsers` 走目录，且分页/游标语义与
 *     内存种子路径**完全一致**（同一套 `pageOf()`：`limit` / `cursor` / `next_cursor`）。
 *  2. **越界即抛**：目录返回契约闭集外 state（`'banned'`，以及数据库枚举独有的 `'deleted'`）
 *     ⇒ 503 `PROVIDER_UNAVAILABLE`，⛔ 不折叠成 `active`、⛔ 不返回空页、⛔ 不丢行。
 *  3. **没目录就维持今天的 fail-closed**：`accountsDirectory: null` 且 store 无账号种子 ⇒ 仍 503；
 *     有目录但 store 无种子 ⇒ 200（证明放行判据是能力对象，不是内存种子标志）。
 *
 * 适配层 `createPostgresAccountsDirectory` 另有一组「假 pool」用例：只认四个白名单列、
 * 驱动错误码映射（42501/42883 → 503，57014/55P03 → 504 retryable）与「构造期不探测」。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminOpsService } from '../../services/api/src/admin/ops/service.ts';
import { createAdminOpsStore } from '../../services/api/src/admin/ops/store.ts';
import { createPostgresAccountsDirectory } from '../../services/api/src/admin/ops/accounts-pg.ts';
import {
  OPS_SIGNING_KEY,
  expectApiError,
  makeUuid,
  opsContext,
} from './admin-ops-fixtures.mjs';

/** 恰好覆盖三种契约状态，顺序即目录返回顺序（= 服务层分页顺序）。 */
const DIRECTORY_ROWS = Object.freeze([
  Object.freeze({ id: makeUuid(401), revision: 1, state: 'active', display_name: '示例用户D' }),
  Object.freeze({ id: makeUuid(402), revision: 3, state: 'suspended', display_name: '示例用户E' }),
  Object.freeze({ id: makeUuid(403), revision: 2, state: 'deletion_pending', display_name: '耕云用户ABCD' }),
]);

/** 假目录：记录调用次数，便于断言「真的走了目录而不是内存种子」。 */
function fakeDirectory(rows = DIRECTORY_ROWS) {
  const calls = { list: 0 };
  return {
    calls,
    directory: {
      async list() {
        calls.list += 1;
        return rows.map((row) => ({ ...row }));
      },
    },
  };
}

/** 无账号种子的 store：`accountsWired === false`（今天的内存路径必须 503）。 */
function unwiredStore() {
  const store = createAdminOpsStore();
  assert.equal(store.accountsWired, false, '无账号种子时 store.accountsWired 必须为 false');
  return store;
}

function serviceWith(options) {
  return createAdminOpsService({
    store: options.store,
    now: () => new Date('2026-10-18T00:00:00.000Z'),
    signingKey: OPS_SIGNING_KEY,
    accountsDirectory: options.accountsDirectory,
  });
}

// ---------------------------------------------------------------- 读面放行 + 分页

test('注入真实目录 ⇒ listAdminUsers 200、恰好三行且字段集合恰为四列', async () => {
  const { directory, calls } = fakeDirectory();
  const service = serviceWith({ store: unwiredStore(), accountsDirectory: directory });

  const response = await service.listAdminUsers(opsContext());

  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  const items = response.body.data.items;
  assert.equal(items.length, 3, '目录三行必须原样返回三行（⛔ 过滤掉任何越界/停用行）');
  assert.deepEqual(
    items.map((item) => item.id),
    DIRECTORY_ROWS.map((row) => row.id),
    '顺序必须是目录返回顺序（真实适配层已按 created_at ASC, id ASC 定序）',
  );
  for (const item of items) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ['display_name', 'id', 'revision', 'state'],
      '账号读面只允许透出 id/revision/state/display_name 四列',
    );
  }
  assert.deepEqual(
    items.map((item) => item.state),
    ['active', 'suspended', 'deletion_pending'],
  );
  assert.equal(items[1].revision, 3);
  assert.equal(response.body.data.next_cursor, null);
  assert.equal(calls.list, 1, '一次请求只读一次目录（不重复全表读）');
});

test('分页游标在真实目录上语义不变：limit=2 翻两页恰好覆盖三行且不重不漏', async () => {
  const { directory } = fakeDirectory();
  const service = serviceWith({ store: unwiredStore(), accountsDirectory: directory });

  const first = await service.listAdminUsers(opsContext(), { limit: '2' });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.items.length, 2);
  const cursor = first.body.data.next_cursor;
  assert.equal(typeof cursor, 'string', '还有第三行 ⇒ 必须给出 next_cursor');
  assert.ok(cursor.length > 0);

  const second = await service.listAdminUsers(opsContext(), { limit: '2', cursor });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.items.length, 1);
  assert.equal(second.body.data.next_cursor, null);

  const seen = [...first.body.data.items, ...second.body.data.items].map((item) => item.id);
  assert.deepEqual(seen, DIRECTORY_ROWS.map((row) => row.id), '两页拼接必须恰好是目录全集（不重不漏）');
  assert.deepEqual([...new Set(seen)].length, 3);

  // 游标属于 `accounts` 列表，不得拿分类/作业的游标串用（签名载荷里有 listKey）。
  const wrongList = await expectApiError(
    () => service.listAdminUsers(opsContext(), { limit: '2', cursor: 'not-a-real-cursor' }),
    'INVALID_CURSOR',
  );
  assert.equal(wrongList.status, 400);
});

test('目录返回越界 state ⇒ 503 PROVIDER_UNAVAILABLE（不折叠、不空页、不丢行）', async () => {
  for (const state of ['banned', 'deleted']) {
    const { directory } = fakeDirectory([
      { id: makeUuid(411), revision: 1, state: 'active', display_name: '正常账号' },
      { id: makeUuid(412), revision: 1, state, display_name: '越界账号' },
      { id: makeUuid(413), revision: 1, state: 'suspended', display_name: '停用账号' },
    ]);
    const service = serviceWith({ store: unwiredStore(), accountsDirectory: directory });

    const error = await expectApiError(() => service.listAdminUsers(opsContext()), 'PROVIDER_UNAVAILABLE');
    assert.equal(error.status, 503);
    assert.equal(error.retryable, false, '未知状态是"不可用"，不是可重试的暂态');
    assert.match(error.message, /state/, '错误信息要指出问题在 state，便于值班定位');
  }
});

test('目录返回空 display_name ⇒ 503（契约 display_name 是 minLength:1）', async () => {
  const { directory } = fakeDirectory([
    { id: makeUuid(421), revision: 1, state: 'active', display_name: '' },
  ]);
  const service = serviceWith({ store: unwiredStore(), accountsDirectory: directory });
  const error = await expectApiError(() => service.listAdminUsers(opsContext()), 'PROVIDER_UNAVAILABLE');
  assert.equal(error.status, 503);
});

// ---------------------------------------------------------------- 无目录 ⇒ 今天的行为

test('没有目录（null）且 store 无账号种子 ⇒ 仍 503，错误与接线前逐字一致', async () => {
  const service = serviceWith({ store: unwiredStore(), accountsDirectory: null });
  const error = await expectApiError(() => service.listAdminUsers(opsContext()), 'PROVIDER_UNAVAILABLE');
  assert.equal(error.status, 503);
  assert.equal(error.retryable, false);
  assert.equal(error.message, '账号读/停用面尚未接线到认证权威');
});

test('显式不传 accountsDirectory（未接线形态）⇒ 与传 null 完全等价', async () => {
  const service = createAdminOpsService({
    store: unwiredStore(),
    now: () => new Date('2026-10-18T00:00:00.000Z'),
    signingKey: OPS_SIGNING_KEY,
  });
  const error = await expectApiError(() => service.listAdminUsers(opsContext()), 'PROVIDER_UNAVAILABLE');
  assert.equal(error.status, 503);
  assert.equal(error.message, '账号读/停用面尚未接线到认证权威');
});

test('有目录但 store 无种子 ⇒ 200（放行判据是能力对象，不是内存种子标志）', async () => {
  const { directory, calls } = fakeDirectory();
  const store = unwiredStore();
  const service = serviceWith({ store, accountsDirectory: directory });

  assert.equal(store.accountsWired, false, '本用例刻意让内存种子路径保持未接线');
  assert.equal(service.accountsWired, false, '外壳可观测字段仍如实反映内存种子路径');

  const response = await service.listAdminUsers(opsContext());
  assert.equal(response.status, 200);
  assert.equal(response.body.data.items.length, 3);
  assert.equal(calls.list, 1);
});

test('没有 accounts:read scope ⇒ 403 SCOPE_DENIED，且目录一次都不被读', async () => {
  const { directory, calls } = fakeDirectory();
  const service = serviceWith({ store: unwiredStore(), accountsDirectory: directory });
  const context = opsContext({ identity: { ...opsContext().identity, scopes: ['accounts:suspend'] } });

  const error = await expectApiError(() => service.listAdminUsers(context), 'SCOPE_DENIED');
  assert.equal(error.status, 403);
  assert.equal(calls.list, 0, '越权请求不得触达真实目录');
});

// ---------------------------------------------------------------- 适配层（假 pool）

test('适配层 SQL 逐字只读四列函数，并只映射四列', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      // 驱动多给的列（模拟未来有人往函数里加列）不得被透出。
      return {
        rows: [{
          id: makeUuid(431),
          revision: 7,
          state: 'deletion_pending',
          display_name: '耕云用户FFFF',
          nickname: '不应透出的昵称',
          auth_epoch: 99,
          deletion_generation: 3,
        }],
      };
    },
  };
  const directory = createPostgresAccountsDirectory({ pool });
  const rows = await directory.list();

  assert.equal(queries.length, 1);
  assert.equal(queries[0].params, undefined, '读面不带参数（无注入面）');
  assert.match(queries[0].sql, /^SELECT id, revision, state, display_name FROM public\.list_admin_accounts\(\)$/);
  assert.ok(!/\*/.test(queries[0].sql), '读面 SQL 不得出现 SELECT *');
  assert.ok(!/FROM public\.users/.test(queries[0].sql), '读面不得直接读 users 表（运行时无 nickname/created_at 列权限）');
  assert.deepEqual(rows, [{ id: makeUuid(431), revision: 7, state: 'deletion_pending', display_name: '耕云用户FFFF' }]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['display_name', 'id', 'revision', 'state']);
});

test('适配层：state 越界/缺列/非正整数 ⇒ 503；驱动错误码映射', async () => {
  const cases = [
    { rows: [{ id: makeUuid(441), revision: 1, state: 'deleted', display_name: 'x' }], label: 'deleted（数据库枚举有、契约没有）' },
    { rows: [{ id: makeUuid(442), revision: 1, state: 'banned', display_name: 'x' }], label: '未知状态' },
    { rows: [{ revision: 1, state: 'active', display_name: 'x' }], label: '缺 id' },
    { rows: [{ id: makeUuid(443), revision: 0, state: 'active', display_name: 'x' }], label: 'revision 非正' },
    { rows: [{ id: makeUuid(444), revision: 1, state: 'active', display_name: '' }], label: '空 display_name' },
    { rows: [null], label: '非对象行' },
  ];
  for (const item of cases) {
    const directory = createPostgresAccountsDirectory({ pool: { async query() { return { rows: item.rows }; } } });
    const error = await expectApiError(() => directory.list(), 'PROVIDER_UNAVAILABLE');
    assert.equal(error.status, 503, `${item.label} 必须是 503`);
    assert.equal(error.retryable, false, `${item.label} 不得标成可重试`);
  }

  const permission = createPostgresAccountsDirectory({
    pool: { async query() { const error = new Error('permission denied for table users'); error.code = '42501'; throw error; } },
  });
  const denied = await expectApiError(() => permission.list(), 'PROVIDER_UNAVAILABLE');
  assert.equal(denied.status, 503);
  assert.ok(!/permission denied/.test(denied.message), '不得把驱动原文透给调用方');

  const missingFunction = createPostgresAccountsDirectory({
    pool: { async query() { const error = new Error('function does not exist'); error.code = '42883'; throw error; } },
  });
  await expectApiError(() => missingFunction.list(), 'PROVIDER_UNAVAILABLE');

  for (const code of ['57014', '55P03']) {
    const timeout = createPostgresAccountsDirectory({
      pool: { async query() { const error = new Error('timeout'); error.code = code; throw error; } },
    });
    const error = await expectApiError(() => timeout.list(), 'PROVIDER_TIMEOUT');
    assert.equal(error.status, 504);
    assert.equal(error.retryable, true, `${code} 是可重试的暂态`);
  }
});

test('适配层构造期不探测：无 pool 时仍能构造，调用期如实 503', async () => {
  const directory = createPostgresAccountsDirectory({ pool: null });
  const error = await expectApiError(() => directory.list(), 'PROVIDER_UNAVAILABLE');
  assert.equal(error.status, 503);
  assert.equal(error.retryable, false);
});
