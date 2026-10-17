/**
 * GY-I22 缺陷① · 账号面「无认证权威 ⇒ fail-closed」单元回归（**只新增断言，不改既有**）。
 *
 * 背景（改前实测）：默认装配（`app.ts` 自建 `createAdminOpsStore({ runtime, flagSeed })`，不给账号种子）
 * 下 `GET /admin/accounts` 返回 **200 空页**、`POST /admin/accounts/{id}/suspend` 返回 **404 账号不存在**
 * ——两者都在把一个"本进程无权回答"的问题说成"平台没有账号 / 账号不存在"。
 *
 * 本文件钉住四件事（每件都带对照，防"一刀切 503"式过度修复）：
 *  1. 接线标志只由**有没有被给定权威来源**决定：不给 = 未接线；给 `[]` = 明确声明"当前没有账号"；
 *  2. 未接线 ⇒ 两个账号操作一律 503 `PROVIDER_UNAVAILABLE`（**不可重试**：接线是运维动作），且**零运行时副作用**
 *     （守卫在写外壳**之前** ⇒ 连幂等占位都不占，不写审计、不迁移状态）；
 *  3. 未接线**不放宽**既有判定顺序：越权仍 `SCOPE_DENIED`，字段/路径格式错误仍各自的 `INVALID_REQUEST`；
 *  4. 已接线（含"权威说没有账号"的空权威）不得被本片误伤，且守卫不外溢到作业面。
 *
 * 口径来源：形态照作业面 `requireWiredJobPort()`（`admin/ops/service.ts`），但 `retryable` 按指挥裁定
 * （`STATE-current.md` §40）取 **false** —— "能力未接线"属运维动作，无运维介入下重试不可能成功；
 * 作业面旧形态的 `true` 由统一口径片处理，本片不代改（作业面断言逐字未动）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminOpsService } from '../../services/api/src/admin/ops/service.ts';
import { createAdminOpsStore } from '../../services/api/src/admin/ops/store.ts';
import { createAdminRuntime } from '../../services/api/src/admin/runtime.ts';
import {
  OPS_SIGNING_KEY,
  USER_A,
  accountSeed,
  createOpsHarness,
  expectApiError,
  makeUuid,
  opsContext,
  opsIdentity,
  opsKey,
} from './admin-ops-fixtures.mjs';

/** 契约内合法的 uuid，但**不在**任何种子里（"形状对、不存在"）。 */
const ABSENT_UUID = makeUuid(999);
const BAD_UUID = 'not-a-uuid';

/**
 * 记录运行时（runtime）上的每一次方法调用。
 * 用来证明"未接线时零副作用"：`transaction` / `claimIdempotent` / `append` 只要被碰过就会记下来。
 */
function recordingRuntime() {
  const calls = [];
  const inner = createAdminRuntime();
  const runtime = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      return (...args) => {
        calls.push(String(prop));
        return value.apply(target, args);
      };
    },
  });
  return { runtime, calls };
}

/** 未接线（不给账号种子）的服务 + 可核对的调用记录。 */
function unwiredService() {
  const { runtime, calls } = recordingRuntime();
  const store = createAdminOpsStore({ runtime });
  const service = createAdminOpsService({ store, signingKey: OPS_SIGNING_KEY });
  return { service, store, calls };
}

test('接线标志：不给权威来源 = 未接线；给 `[]` 是明确声明，不得把"空"当"未接线"', () => {
  assert.equal(createAdminOpsStore().accountsWired, false, '不给账号种子 ⇒ 账号面未接线');
  assert.equal(createAdminOpsStore({ categorySeed: [] }).accountsWired, false, '只给分类种子不解账号面的接线');
  assert.equal(createAdminOpsStore({ accountSeed: [] }).accountsWired, true, '`[]` 是"权威说当前没有账号"的明确声明');
  assert.equal(createAdminOpsStore({ accountSeed: accountSeed() }).accountsWired, true, '给了账号种子 ⇒ 已接线');
});

test('未接线：listAdminUsers / suspendUser 一律 503 PROVIDER_UNAVAILABLE（不可重试），且零运行时副作用', async () => {
  const { service, store, calls } = unwiredService();
  const ctx = opsContext();

  const listError = await expectApiError(() => service.listAdminUsers(ctx), 'PROVIDER_UNAVAILABLE');
  assert.equal(listError.status, 503, '未接线必须是 503，不是 200 空页');
  assert.equal(listError.retryable, false, '接线是运维动作：未接线不得宣称可重试（STATE-current §40）');

  const suspendError = await expectApiError(
    () => service.suspendUser(
      { ...ctx, idempotencyKey: opsKey('unwired-suspend'), ifMatch: '"1"' },
      ABSENT_UUID,
      { reason: '示例：停用' },
    ),
    'PROVIDER_UNAVAILABLE',
  );
  assert.equal(suspendError.status, 503, '未接线不得把"没有权威"报成"账号不存在"(404) 或伪造成功(200)');
  assert.equal(suspendError.retryable, false, '接线是运维动作：未接线不得宣称可重试（STATE-current §40）');

  assert.deepEqual(calls, [], '未接线时不得触碰运行时：不进临界区、不占幂等键、不迁移状态、不写审计');
  assert.deepEqual(store.audit.list(), [], '未接线不得留下审计');
  assert.equal(store.snapshotCounts().accounts, 0, '未接线不得凭空造出账号行');
});

test('未接线不放宽既有判定：越权仍 SCOPE_DENIED，路径/字段格式错误仍 INVALID_REQUEST', async () => {
  const { service } = unwiredService();
  const readOnly = opsContext({ identity: opsIdentity({ scopes: ['flags:read'] }) });

  await expectApiError(() => service.listAdminUsers(readOnly), 'SCOPE_DENIED');
  await expectApiError(
    () => service.suspendUser(
      { ...readOnly, idempotencyKey: opsKey('unwired-noscope'), ifMatch: '"1"' },
      ABSENT_UUID,
      { reason: '示例：无权限停用' },
    ),
    'SCOPE_DENIED',
  );
  await expectApiError(
    () => service.suspendUser(
      { ...opsContext(), idempotencyKey: opsKey('unwired-baduuid'), ifMatch: '"1"' },
      BAD_UUID,
      { reason: '示例：停用' },
    ),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => service.suspendUser(
      { ...opsContext(), idempotencyKey: opsKey('unwired-badbody'), ifMatch: '"1"' },
      ABSENT_UUID,
      { reason: '' },
    ),
    'INVALID_REQUEST',
  );
});

test('已接线（含"权威说没有账号"的空权威）不得被误伤：空页是合法答案，未知账号仍是 404', async () => {
  const { service, store } = createOpsHarness({ accountSeed: [] });
  assert.equal(store.accountsWired, true, '显式空种子 ⇒ 已接线');

  const page = await service.listAdminUsers(opsContext());
  assert.equal(page.status, 200, '已接线 ⇒ 200（空清单是权威的答案，不是"没接线"）');
  assert.deepEqual(page.body.data.items, []);
  assert.equal(page.body.data.next_cursor, null);

  await expectApiError(
    () => service.suspendUser(
      { ...opsContext(), idempotencyKey: opsKey('wired-absent'), ifMatch: '"1"' },
      USER_A.userId,
      { reason: '示例：停用' },
    ),
    'NOT_FOUND',
  );
  assert.deepEqual(store.audit.list(), [], '404 不得留审计（与既有语义一致）');
});

test('守卫不外溢：作业面未接线时账号面照旧可用（两个面的接线状态互不牵连）', async () => {
  const { service } = createOpsHarness({ wireJobs: false });

  await expectApiError(() => service.listAdminJobs(opsContext()), 'PROVIDER_UNAVAILABLE');
  const accounts = await service.listAdminUsers(opsContext());
  assert.equal(accounts.status, 200, '作业端口未接线不得连带把账号面打成 503');
  assert.equal(accounts.body.data.items.length, 3, '账号种子 3 条');
});
