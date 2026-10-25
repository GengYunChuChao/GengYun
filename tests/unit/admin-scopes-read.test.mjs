/**
 * `#18` S2 PR-2 · 后台**只读展示他人权限**（`scopes:read`）· 单元回归。
 *
 * 真库臂见 `tests/integration/admin-scopes-read-pg.mjs`（无真库环境时按原因 exit 77，**不是通过**）；
 * 本文件全部用**内存假实现**，只钉派单里点名的那几条与几条不可放宽的口径：
 *  1. 返回体**只含 scope 字符串数组** —— ⛔ 无 `granted_by` / `granted_at`（运行时角色对
 *     `admin_scopes` 只有三列 SELECT，这两列根本读不到）；
 *  2. 缺 `scopes:read` ⇒ 现有 403 `SCOPE_DENIED`，且**一次都不触达**权限读面；
 *  3. **`accounts:read` 不等于可读他人权限**（裁定④：两种能力），同一个人能列终端用户却读不到管理员权限；
 *  4. 目标不存在 ⇒ 现有 404 `NOT_FOUND`（⛔ 不退化成"这个人没有任何权限"的空数组）；
 *  5. 目录项的 `id` 来自 `admin_accounts` 而**不是** `users`：两个 id 空间没有映射，
 *     拿用户 id 去查必须 404（m00260 追加要求的证明）；
 *  6. 未接线 ⇒ 503（⛔ 空数组/空页），且**形态校验先于接线状态**（非法 uuid 在未接线时仍 400）。
 *
 * 顺带钉住出口守卫：库/端口读回闭集外的 scope 时整条读面 503，⛔ 既不静默丢弃该条
 * （丢弃会把"权限不明"读成"没有这项权限"），也不原样照抄给调用方。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminOpsService } from '../../services/api/src/admin/ops/service.ts';
import { createAdminOpsStore } from '../../services/api/src/admin/ops/store.ts';
import { createAuthStoreAdministratorsDirectory } from '../../services/api/src/admin/ops/administrators.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { ADMIN_SCOPES } from '../../services/api/src/admin/scopes.ts';
import { ADMIN_HTTP_OPERATION_IDS } from '../../services/api/src/routes/admin.ts';
import { OPS_SIGNING_KEY, expectApiError, makeUuid, opsIdentity } from './admin-ops-fixtures.mjs';

const API = '/api/v1';
const ADMIN_ID = makeUuid(501);
const SUSPENDED_ID = makeUuid(502);
const MISSING_ID = makeUuid(599);

/** 只带 `scopes:read` 的操作者：证明本端点**不**依赖 `accounts:read`。 */
function readContext(scopes = ['scopes:read']) {
  return { identity: opsIdentity({ scopes }) };
}

function serviceWith(options = {}) {
  return createAdminOpsService({
    store: options.store ?? createAdminOpsStore(),
    now: () => new Date('2026-10-25T00:00:00.000Z'),
    signingKey: OPS_SIGNING_KEY,
    administrators: options.administrators,
    accountsDirectory: options.accountsDirectory,
  });
}

/**
 * 假目录：`read` 按 id 查表（未登记 ⇒ `null`，与真实适配层的 `getAdmin()` 判存在同形），
 * 并记录调用次数，便于断言"越权请求一次都没有触达读面"。
 */
function fakeDirectory(rows = [{ id: ADMIN_ID, login_name: 'ops-a', state: 'active', scopes: ['sources:read'] }]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const calls = { read: 0, list: 0 };
  return {
    calls,
    directory: {
      async read(administratorId) {
        calls.read += 1;
        const row = byId.get(administratorId);
        // 断言适配层返回的是"只有 scopes"的快照：多带字段在真实实现里不存在，
        // 这里也刻意不返回 state/login_name，免得服务层悄悄学坏。
        return row === undefined ? null : { scopes: [...row.scopes] };
      },
      async list() {
        calls.list += 1;
        return rows.map((row) => ({ ...row, scopes: [...row.scopes] }));
      },
    },
  };
}

// ---------------------------------------------------------------- 单条读面：只返 scope 数组

test('GET /admin/administrators/{id}/scopes：只返 scope 字符串数组，⛔ 无 granted_by/granted_at', async () => {
  const { directory } = fakeDirectory([
    { id: ADMIN_ID, login_name: 'ops-a', state: 'active', scopes: ['sources:read', 'accounts:read'] },
  ]);
  const service = serviceWith({ administrators: directory });

  const response = await service.listAdministratorScopes(readContext(), ADMIN_ID);

  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  // 权限集合没有独立修订号 ⇒ 不发 ETag（拿 admin_accounts.revision 会谎称"集合没变"）。
  assert.equal(response.headers['ETag'], undefined, '权限读面不得发 ETag');

  assert.deepEqual(Object.keys(response.body.data), ['scopes'], 'data 只允许一个键：scopes');
  assert.deepEqual(response.body.data.scopes, ['accounts:read', 'sources:read']);
  assert.equal(response.body.meta !== undefined, true, '封套仍带 meta（与既有读面同形）');

  const serialized = JSON.stringify(response.body);
  assert.ok(!/granted_by/.test(serialized), '响应体不得出现 granted_by');
  assert.ok(!/granted_at/.test(serialized), '响应体不得出现 granted_at');
  assert.ok(!/login_name|state|revision/.test(serialized), '权限读面不得夹带账号视图字段');
});

test('scope 去重 + 码元序：与自查接口（会话 scopes）同口径，不按存储插入序漂移', async () => {
  const { directory } = fakeDirectory([
    { id: ADMIN_ID, login_name: 'ops-a', state: 'active', scopes: ['sources:read', 'accounts:read', 'sources:read'] },
  ]);
  const service = serviceWith({ administrators: directory });

  const response = await service.listAdministratorScopes(readContext(), ADMIN_ID);
  assert.deepEqual(response.body.data.scopes, ['accounts:read', 'sources:read']);
  assert.equal(response.body.data.scopes.length, 2, '重复 scope 必须去重');
});

test('空权限集合 ⇒ 200 + 空数组（"能查、确实没有权限"，不是 404）', async () => {
  const { directory } = fakeDirectory([{ id: ADMIN_ID, login_name: 'ops-a', state: 'active', scopes: [] }]);
  const service = serviceWith({ administrators: directory });

  const response = await service.listAdministratorScopes(readContext(), ADMIN_ID);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.scopes, []);
});

// ---------------------------------------------------------------- 404 / 403 / 503

test('目标不存在 ⇒ 现有 404 NOT_FOUND（⛔ 不返回空数组"这个人没有任何权限"）', async () => {
  const { directory, calls } = fakeDirectory();
  const service = serviceWith({ administrators: directory });

  const error = await expectApiError(() => service.listAdministratorScopes(readContext(), MISSING_ID), 'NOT_FOUND');
  assert.equal(error.status, 404, '不存在必须走现有 404，不新增错误码（新错误码属 PR-3）');
  assert.equal(calls.read, 1, '存在性判定必须问过读面（不能凭空 404）');
});

test('缺 scopes:read ⇒ 现有 403 SCOPE_DENIED，且读面一次都不被触达', async () => {
  const { directory, calls } = fakeDirectory();
  const service = serviceWith({ administrators: directory });

  const error = await expectApiError(
    () => service.listAdministratorScopes(readContext(['accounts:read', 'accounts:suspend']), ADMIN_ID),
    'SCOPE_DENIED',
  );
  assert.equal(error.status, 403);
  assert.equal(calls.read, 0, '越权请求不得触达权限读面');
  assert.equal(calls.list, 0);
});

test('accounts:read 不等于可读他人权限：同一操作者能列终端用户，却读不到管理员权限', async () => {
  const accountsRows = [{ id: makeUuid(601), revision: 1, state: 'active', display_name: '示例用户A' }];
  const { directory: administrators, calls } = fakeDirectory();
  const service = serviceWith({
    administrators,
    accountsDirectory: { async list() { return accountsRows.map((row) => ({ ...row })); } },
  });
  const context = readContext(['accounts:read']);

  // 反面：`/admin/accounts` 这条路走的是 `accounts:read`，同一 context 下 200。
  const accounts = await service.listAdminUsers(context);
  assert.equal(accounts.status, 200, '前置条件：该操作者确实持有 accounts:read');

  // 正面：同一个人读他人权限必须 403 —— 两种能力，不是同一个门。
  const error = await expectApiError(() => service.listAdministratorScopes(context, ADMIN_ID), 'SCOPE_DENIED');
  assert.equal(error.status, 403);
  assert.equal(calls.read, 0);
});

test('未接线（无读面）⇒ 503 PROVIDER_UNAVAILABLE retryable:false；但非法 uuid 仍先报 400', async () => {
  const service = serviceWith({ administrators: null });

  const denied = await expectApiError(() => service.listAdministratorScopes(readContext(), ADMIN_ID), 'PROVIDER_UNAVAILABLE');
  assert.equal(denied.status, 503);
  assert.equal(denied.retryable, false, '运维未接线：重试不会成功');

  // 顺序：`resolveContext` → `normalizeIdParam` → 未接线 503。形态校验先于接线状态，
  // 与既有 `suspendUser` 的口径一致（否则未接线时一切路径都变 503，掩盖参数错误）。
  let badUuid;
  try {
    await service.listAdministratorScopes(readContext(), 'not-a-uuid');
  } catch (error) {
    badUuid = error;
  }
  assert.equal(badUuid?.code, 'INVALID_REQUEST', '非法 uuid 必须仍是 400，不被 503 顶掉');
  assert.equal(badUuid?.status, 400);
});

test('读回闭集外 scope ⇒ 503（⛔ 不静默丢弃、⛔ 不原样照抄）', async () => {
  for (const bad of ['scopes:grant', 'root', '']) {
    const { directory } = fakeDirectory([{ id: ADMIN_ID, login_name: 'ops-a', state: 'active', scopes: [bad] }]);
    const service = serviceWith({ administrators: directory });
    const error = await expectApiError(
      () => service.listAdministratorScopes(readContext(), ADMIN_ID),
      'PROVIDER_UNAVAILABLE',
    );
    assert.equal(error.status, 503, `闭集外的 ${JSON.stringify(bad)} 必须让整条读面失败`);
    assert.equal(error.retryable, false);
    assert.match(error.message, /scope/, '错误信息要指出问题在 scope，便于值班定位');
  }
});

// ---------------------------------------------------------------- 目录：id 必须是 admin_accounts.id

test('GET /admin/administrators：列表项 id 来自 admin_accounts，⛔ 不是 users.id（两个 id 空间无映射）', async () => {
  // 关键：**同一时刻**两个目录各自返回自己的 id 空间，且两边 id 互不相同。
  const adminId = makeUuid(701);
  const usersId = makeUuid(702);
  const { directory: administrators } = fakeDirectory([
    { id: adminId, login_name: 'ops-a', state: 'active', scopes: ['scopes:read'] },
    { id: SUSPENDED_ID, login_name: 'ops-b', state: 'suspended', scopes: ['accounts:read'] },
  ]);
  const service = serviceWith({
    administrators,
    accountsDirectory: {
      async list() {
        return [{ id: usersId, revision: 1, state: 'active', display_name: '示例用户A' }];
      },
    },
  });

  const list = await service.listAdministrators(readContext());
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.body.data.items.map((item) => item.id),
    [adminId, SUSPENDED_ID],
    '目录 id 必须逐字来自 admin_accounts（含 suspended 行，不按 state 过滤）',
  );

  const serialized = JSON.stringify(list.body);
  assert.ok(!serialized.includes(usersId), '用户 id 不得出现在管理员目录里');
  assert.ok(!serialized.includes('display_name'), '管理员目录不得夹带终端用户字段');

  // 反向证明：拿 users.id 去读权限 ⇒ 404；拿 admin_accounts.id ⇒ 200。
  const asUser = await expectApiError(() => service.listAdministratorScopes(readContext(), usersId), 'NOT_FOUND');
  assert.equal(asUser.status, 404, 'users.id 不是管理员 id，必须 404');
  const asAdmin = await service.listAdministratorScopes(readContext(), adminId);
  assert.equal(asAdmin.status, 200);
  assert.deepEqual(asAdmin.body.data.scopes, ['scopes:read']);
});

test('目录分页：limit=1 翻两页恰好覆盖全部管理员，不重不漏', async () => {
  const rows = [
    { id: makeUuid(711), login_name: 'ops-a', state: 'active', scopes: ['scopes:read'] },
    { id: makeUuid(712), login_name: 'ops-b', state: 'active', scopes: [] },
    { id: makeUuid(713), login_name: 'ops-c', state: 'suspended', scopes: ['accounts:read'] },
  ];
  const { directory } = fakeDirectory(rows);
  const service = serviceWith({ administrators: directory });

  const first = await service.listAdministrators(readContext(), { limit: '2' });
  assert.equal(first.body.data.items.length, 2);
  const cursor = first.body.data.next_cursor;
  assert.equal(typeof cursor, 'string', '还有第三行 ⇒ 必须给出 next_cursor');

  const second = await service.listAdministrators(readContext(), { limit: '2', cursor });
  assert.equal(second.body.data.items.length, 1);
  assert.equal(second.body.data.next_cursor, null);

  const seen = [...first.body.data.items, ...second.body.data.items].map((item) => item.id);
  assert.deepEqual(seen, rows.map((row) => row.id), '两页拼接必须恰好是目录全集（不重不漏）');
});

test('目录 state 越界 ⇒ 503（admin_state 库层只有 active/suspended，不折叠、不丢行）', async () => {
  const { directory } = fakeDirectory([
    { id: makeUuid(721), login_name: 'ops-a', state: 'deleted', scopes: [] },
  ]);
  const service = serviceWith({ administrators: directory });
  const error = await expectApiError(() => service.listAdministrators(readContext()), 'PROVIDER_UNAVAILABLE');
  assert.equal(error.status, 503);
  assert.equal(error.retryable, false);
  assert.match(error.message, /state/);
});

test('目录未接线 ⇒ 503（⛔ 不返回空页"平台没有管理员"）', async () => {
  const service = serviceWith({});
  const error = await expectApiError(() => service.listAdministrators(readContext()), 'PROVIDER_UNAVAILABLE');
  assert.equal(error.status, 503);
  assert.equal(error.retryable, false);
});

// ---------------------------------------------------------------- 真实投影：认证存储（内存实现）

test('真实投影：读的是认证存储的管理员（createAdmin），用户账号读不到', async () => {
  const store = createMemoryAuthStore();
  const user = await store.createUser('a'.repeat(64));
  const adminId = await store.createAdmin({
    loginName: 'ops-a',
    credentialHash: 'b'.repeat(64),
    scopes: ['scopes:read', 'accounts:read'],
  });
  await store.createAdmin({ loginName: 'ops-b', credentialHash: 'c'.repeat(64), scopes: [] });

  const service = serviceWith({ administrators: createAuthStoreAdministratorsDirectory({ store }) });

  const list = await service.listAdministrators(readContext());
  assert.equal(list.status, 200);
  // 管理员 id 是随机 uuid，创建顺序 ≠ 目录顺序：目录必须沿用 `listAdmins()` 的 id 码元序
  // （PG 的 `ORDER BY id ASC`），否则游标分页的位置不可复现。
  const admins = await store.listAdmins();
  assert.deepEqual(list.body.data.items.map((item) => item.id), admins.map((admin) => admin.id));
  assert.deepEqual(list.body.data.items.map((item) => item.login_name).sort(), ['ops-a', 'ops-b']);
  assert.ok(!JSON.stringify(list.body).includes(user.id), '用户 id 不得出现在管理员目录里');

  const own = await service.listAdministratorScopes(readContext(), adminId);
  assert.deepEqual(own.body.data.scopes, ['accounts:read', 'scopes:read'], '去重 + 码元序');

  const asUser = await expectApiError(() => service.listAdministratorScopes(readContext(), user.id), 'NOT_FOUND');
  assert.equal(asUser.status, 404);
});

test('真实投影：`listAdmins()` 按 id 码元序（游标分页才有可复现的位置）', async () => {
  const store = createMemoryAuthStore();
  for (const loginName of ['ops-c', 'ops-a', 'ops-b']) {
    await store.createAdmin({ loginName, credentialHash: 'd'.repeat(64), scopes: [] });
  }
  const admins = await store.listAdmins();
  const ids = admins.map((admin) => admin.id);
  assert.deepEqual(ids, [...ids].sort(), '内存实现必须与 PG 的 ORDER BY id ASC 同序');
});

test('真实投影：注入对象缺 listAdmins ⇒ 调用期 503（形状守卫，不伪造成功）', async () => {
  const brokenStore = {
    persistent: true,
    async getAdmin() { return null; },
    async listAdminScopes() { return []; },
  };
  const directory = createAuthStoreAdministratorsDirectory({ store: brokenStore });
  const error = await expectApiError(() => directory.list(), 'PROVIDER_UNAVAILABLE');
  assert.equal(error.status, 503);
  assert.equal(error.retryable, false);

  const service = serviceWith({ administrators: directory });
  const viaService = await expectApiError(
    () => service.listAdministratorScopes(readContext(), ADMIN_ID),
    'PROVIDER_UNAVAILABLE',
  );
  assert.equal(viaService.status, 503);
});

// ---------------------------------------------------------------- 接线面：常量与路由

test('两个新 operationId 已装配，且门 scope 逐字是 scopes:read', async () => {
  const { OPS_SCOPES } = await import('../../services/api/src/admin/ops/service.ts');
  assert.equal(OPS_SCOPES.listAdministrators, 'scopes:read');
  assert.equal(OPS_SCOPES.listAdministratorScopes, 'scopes:read');
  assert.ok(ADMIN_HTTP_OPERATION_IDS.includes('listAdministrators'));
  assert.ok(ADMIN_HTTP_OPERATION_IDS.includes('listAdministratorScopes'));
  // 闭集里两个新成员都在（`scopes:write` 入闭集但本片**没有**写端点）。
  assert.ok(ADMIN_SCOPES.includes('scopes:read'));
  assert.ok(ADMIN_SCOPES.includes('scopes:write'));
  assert.ok(!ADMIN_HTTP_OPERATION_IDS.some((id) => /^(grant|revoke)/i.test(id)), '本片不得出现授予/撤销端点');
  assert.equal(
    ADMIN_HTTP_OPERATION_IDS.filter((id) => id.startsWith('listAdministrator')).length,
    2,
    '管理员读面恰好两条',
  );
});

test('路由表：两条新路由挂在 /admin/administrators，路径前缀与契约一致', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../services/api/src/routes/admin.ts', import.meta.url), 'utf8');
  assert.match(source, new RegExp('app\\.get\\(\\n    `\\$\\{API_PREFIX\\}/admin/administrators`'));
  assert.match(source, new RegExp('app\\.get\\(\\n    `\\$\\{API_PREFIX\\}/admin/administrators/:id/scopes`'));
  assert.ok(source.includes('${API_PREFIX}/admin/administrators'), '路径必须与契约逐字一致');
  assert.ok(!source.includes('/admin/accounts/:id/scopes'), '⛔ 不得把权限读面挂到 /admin/accounts 名下');
});
