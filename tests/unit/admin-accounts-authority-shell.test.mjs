/**
 * GY-I22（#22）· `real` 模式「能力级 fail-closed 外壳」单元回归（**只新增**，不改任何既有断言）。
 *
 * 被测对象：`services/api/src/admin/ops/accounts-only.ts` 的 `restrictAdminOpsToAccountsAuthority()`。
 * 它解决的矛盾：`app.ts` 在 `real` 下把**整个**后台域换成整域 503 替身（正确默认），
 * 但账号停用本片已接上真实单事务权威；若一并挡死，主检出里就没有一条可验证的真实停用路径。
 *
 * 本文件钉住四条（每条都成对，防"顺手把别的操作也放行"）：
 *  1. **唯一放行**：`suspendUser` 原样转发（同一函数引用语义：参数与返回值都不改写）；
 *  2. 其余 9 个操作逐条 503 `PROVIDER_UNAVAILABLE` 且 `retryable === false`，且**一个都没真的被调**；
 *  3. 拒绝措辞与整域替身**同源**（同一个 `reason` 字符串，便于回归用同一判据核对"是否被放行"）；
 *  4. 接线状态如实暴露：`accountsWired` 固定 `false`（读面仍不可用），`store`/`jobPort`/`operationIds`
 *     按引用透传（不复制、不改写），⛔ 不把拒绝伪装成"已接线"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restrictAdminOpsToAccountsAuthority } from '../../services/api/src/admin/ops/accounts-only.ts';

const REASON = '账号读/停用面尚未接线到认证权威';

/** 记录每个操作被调用的次数与最后一次入参；`suspendUser` 返回可核对的结果对象。 */
function recordingService() {
  const calls = [];
  const method =
    (name, result) =>
    async (...args) => {
      calls.push({ name, args });
      return result;
    };
  const store = { tag: 'store' };
  const jobPort = { wired: false, tag: 'jobPort' };
  const operationIds = ['a', 'b'];
  const inner = {
    store,
    jobPort,
    accountsWired: true,
    operationIds,
    listAdminCategories: method('listAdminCategories', { status: 200 }),
    editCategory: method('editCategory', { status: 200 }),
    listAdminUsers: method('listAdminUsers', { status: 200 }),
    suspendUser: method('suspendUser', { status: 200, headers: {}, body: { state: 'suspended' } }),
    listAdminJobs: method('listAdminJobs', { status: 200 }),
    cancelAdminJob: method('cancelAdminJob', { status: 200 }),
    listFlags: method('listFlags', { status: 200 }),
    setFlag: method('setFlag', { status: 200 }),
    hidePost: method('hidePost', { status: 200 }),
  };
  return { inner, calls, store, jobPort, operationIds };
}

const REJECTED = [
  'listAdminCategories',
  'editCategory',
  'listAdminUsers',
  'listAdminJobs',
  'cancelAdminJob',
  'listFlags',
  'setFlag',
  'hidePost',
];

test('唯一放行：suspendUser 原样转发（参数与返回值都不改写）', async () => {
  const { inner, calls } = recordingService();
  const shell = restrictAdminOpsToAccountsAuthority(inner, REASON);
  const context = { identity: { userId: 'u1' }, ifMatch: '"3"' };
  const out = await shell.suspendUser(context, 'acc-1', { reason_code: 'account_suspended' });

  assert.deepEqual(out, { status: 200, headers: {}, body: { state: 'suspended' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'suspendUser');
  assert.deepEqual(calls[0].args, [context, 'acc-1', { reason_code: 'account_suspended' }]);
});

test('其余操作逐条 503 PROVIDER_UNAVAILABLE（retryable=false），且一个都没真的被调', async () => {
  const { inner, calls } = recordingService();
  const shell = restrictAdminOpsToAccountsAuthority(inner, REASON);

  for (const name of REJECTED) {
    await assert.rejects(
      () => shell[name]({ identity: { userId: 'u1' } }, 'acc-1', {}),
      (error) => {
        assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `${name} 必须 503`);
        assert.equal(error.status, 503, `${name} HTTP 状态`);
        assert.equal(error.retryable, false, `${name} 接线是运维动作 ⇒ 不可重试`);
        assert.equal(error.message, REASON, `${name} 拒绝措辞必须与整域替身同源`);
        return true;
      },
    );
  }
  assert.deepEqual(calls, [], '被拒操作不得触达内层服务（零副作用）');
});

test('接线状态如实暴露：accountsWired 固定 false，store/jobPort/operationIds 按引用透传', () => {
  const { inner, store, jobPort, operationIds } = recordingService();
  const shell = restrictAdminOpsToAccountsAuthority(inner, REASON);

  assert.equal(shell.accountsWired, false, '本外壳不代表账号面已完整接线');
  assert.equal(shell.store, store);
  assert.equal(shell.jobPort, jobPort);
  assert.equal(shell.operationIds, operationIds);
  for (const name of ['listAdminCategories', 'editCategory', 'listAdminUsers', 'suspendUser', 'listAdminJobs', 'cancelAdminJob', 'listFlags', 'setFlag', 'hidePost']) {
    assert.equal(typeof shell[name], 'function', `${name} 必须存在（契约闭集不得因外壳缺项）`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GY-I18/T-R12-03 新增（⛔ 未改动上面三条既有断言）：读面在真实目录注入时放行。
// ─────────────────────────────────────────────────────────────────────────────

test('第三参 accountsReadWired: true ⇒ 只多放行 listAdminUsers（其余仍逐条 503）', async () => {
  const { inner, calls } = recordingService();
  const shell = restrictAdminOpsToAccountsAuthority(inner, REASON, { accountsReadWired: true });

  const context = { identity: { userId: 'u1' } };
  assert.equal(typeof shell.listAdminUsers, 'function');

  // 读面：原样转发 inner（参数不变、返回值不变、恰好被调一次）。
  const out = await shell.listAdminUsers(context, { limit: '2', cursor: null });
  assert.deepEqual(out, { status: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'listAdminUsers');
  assert.deepEqual(calls[0].args, [context, { limit: '2', cursor: null }]);

  // 停用面：本壳本来就没挡（既有行为），这里只确认它没有在读面放行后被顺手改写。
  const suspended = await shell.suspendUser(context, 'acc-1', { reason_code: 'account_suspended' });
  assert.deepEqual(suspended, { status: 200, headers: {}, body: { state: 'suspended' } });
  assert.equal(calls.length, 2);

  // 其余 7 个操作：仍逐条 503，措辞同源，且一个都没真的被调。
  for (const name of REJECTED.filter((item) => item !== 'listAdminUsers')) {
    await assert.rejects(
      () => shell[name](context, 'acc-1', {}),
      (error) => {
        assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `${name} 必须仍 503`);
        assert.equal(error.status, 503);
        assert.equal(error.retryable, false);
        assert.equal(error.message, REASON);
        return true;
      },
    );
  }
  assert.deepEqual(calls.map((call) => call.name), ['listAdminUsers', 'suspendUser'], '放行集合恰为两项');
});

test('第三参默认/显式 false ⇒ listAdminUsers 与首版逐字相同（仍 503）', async () => {
  for (const options of [undefined, {}, { accountsReadWired: false }]) {
    const { inner, calls } = recordingService();
    const shell = options === undefined
      ? restrictAdminOpsToAccountsAuthority(inner, REASON)
      : restrictAdminOpsToAccountsAuthority(inner, REASON, options);

    await assert.rejects(
      () => shell.listAdminUsers({ identity: { userId: 'u1' } }),
      (error) => {
        assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
        assert.equal(error.status, 503);
        assert.equal(error.retryable, false);
        assert.equal(error.message, REASON);
        return true;
      },
    );
    assert.deepEqual(calls, [], '未接线时读面不得触达内层服务');
    assert.equal(shell.accountsWired, false, 'accountsWired 不随 accountsReadWired 变成 true');
  }
});
