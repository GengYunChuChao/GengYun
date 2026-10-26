/**
 * `#18` S2 PR-3 · 后台管理员 scope 的**写面**（`scopes:write`）· 单元回归。
 *
 * 真库臂追加在 `tests/integration/admin-accounts-read-pg.mjs`（那是 `real-pg-integration.yml`
 * **逐文件列举**里已有的文件；新建 integration 文件 CI 跑不到）。
 *
 * 本文件全部用**内存替身**，钉的是派单点名的那几条不可放宽的口径：
 *  1. 缺 `scopes:write` ⇒ 既有 403 `SCOPE_DENIED`，且**一次都不触达**写权威；
 *  2. **禁止自授** ⇒ 403 `SELF_SCOPE_GRANT_DENIED`（`retryable:false`）；**允许自撤**（裁定④）；
 *  3. 只能授予自己当前有效持有的 scope ⇒ 库层 G0011 ⇒ 403 `SCOPE_DENIED`（复用现有码，裁定⑥）；
 *  4. 目标不存在 ⇒ 404 `NOT_FOUND`；目标非 active ⇒ 409 `OBJECT_UNAVAILABLE`；
 *  5. CAS：缺 `If-Match` ⇒ 428、非法 ⇒ 400、不匹配 ⇒ 409 `REVISION_CONFLICT`；
 *  6. 幂等重放：同键同体只生效一次（第二次不再触达写权威），同键异体 ⇒ 409 `IDEMPOTENCY_CONFLICT`；
 *  7. 撤销最后一名 `scopes:write` 持有者 ⇒ 409 `LAST_SCOPE_MANAGER`（`retryable:false`）；
 *  8. 未接线（real 无库池 / stub 无端口）⇒ 503 `PROVIDER_UNAVAILABLE`（`retryable:false`），
 *     ⛔ 不返回成功封套、⛔ 不占幂等位；
 *  9. 两个端点同时出现在**契约**（openapi + operations.json）与**路由表**（`ADMIN_HTTP_OPERATION_IDS`
 *     + 装配后的 `app.hasRoute`）里 —— 任一处缺失都红。
 *
 * 另外逐条覆盖 G 码 → HTTP/契约码的映射表（`scope-authority-pg.ts` 文件头那张表就是这里的判据）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { createAdminOpsService, OPS_SCOPES } from '../../services/api/src/admin/ops/service.ts';
import { createAdminOpsStore } from '../../services/api/src/admin/ops/store.ts';
import {
  createPostgresAdminScopeAuthority,
  mapAdminScopeAuthorityError,
} from '../../services/api/src/admin/ops/scope-authority-pg.ts';
import { ADMIN_SCOPES } from '../../services/api/src/admin/scopes.ts';
import { ADMIN_HTTP_OPERATION_IDS } from '../../services/api/src/routes/admin.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { OPS_SIGNING_KEY, expectApiError, makeUuid, opsIdentity } from './admin-ops-fixtures.mjs';

const API = '/api/v1';
const ACTOR_ID = makeUuid(801);
const TARGET_ID = makeUuid(802);
const MISSING_ID = makeUuid(899);

const openapi = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const operations = JSON.parse(readFileSync(new URL('../../packages/contracts/operations.json', import.meta.url), 'utf8'));

/**
 * 假写权威：记录每次调用，按场景返回固定读数或抛出 `ApiError`。
 *
 * ⛔ 刻意**不**实现任何"内存里的 admin_scopes"：真实实现没有内存分支（唯一写路径是迁移 0041
 * 的两条函数），替身若自带状态机，用例就会开始证明一件线上不存在的事。
 */
function fakeAuthority(behaviour = {}) {
  const calls = [];
  let revision = behaviour.revision ?? 7;
  const respond = async (kind, action) => {
    calls.push({ kind, action });
    if (behaviour.throwFor !== undefined) throw behaviour.throwFor;
    const outcome = {
      administratorId: action.targetId,
      revision,
      // 授予后集合里多一项、撤销后少一项：替身仍按"函数读数"返回，服务层不许自己算。
      scopes: kind === 'grant' ? [...new Set([...(behaviour.scopes ?? []), action.scope])].sort()
        : (behaviour.scopes ?? []).filter((s) => s !== action.scope).sort(),
      changed: behaviour.changed ?? true,
      auditId: (behaviour.changed ?? true) ? makeUuid(880) : null,
    };
    revision += 1;
    return outcome;
  };
  return {
    calls,
    authority: {
      persistent: true,
      grant: (action) => respond('grant', action),
      revoke: (action) => respond('revoke', action),
    },
  };
}

/** 写面上下文：`scopes:write` + 幂等键 + If-Match 都给齐。 */
function writeContext(overrides = {}) {
  return {
    identity: opsIdentity({ userId: ACTOR_ID, scopes: ['scopes:write', 'scopes:read'] }),
    idempotencyKey: overrides.idempotencyKey ?? 'scope-write-key-0001',
    ifMatch: overrides.ifMatch ?? '"3"',
    requestId: overrides.requestId ?? makeUuid(890),
  };
}

function serviceWith(options = {}) {
  return createAdminOpsService({
    store: options.store ?? createAdminOpsStore(),
    now: () => new Date('2026-10-26T00:00:00.000Z'),
    signingKey: OPS_SIGNING_KEY,
    scopeAuthority: options.scopeAuthority,
  });
}

function grantBody(overrides = {}) {
  return { scope: 'audit:read', reason: '轮班交接：需要审计读权限', ...overrides };
}

// ---------------------------------------------------------------- 正常路径

test('授予：200 + 契约快照（id/revision/scopes/changed），写权威收到的入参逐字正确', async () => {
  const { authority, calls } = fakeAuthority({ scopes: ['sources:read'], revision: 3 });
  const service = serviceWith({ scopeAuthority: authority });

  const response = await service.grantAdministratorScope(writeContext(), TARGET_ID, grantBody());

  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  // 写面**发** ETag（它确实推进了 admin_accounts.revision），与只读权限面刻意不发 ETag 形成对照。
  assert.equal(response.headers.ETag, '"3"');
  assert.deepEqual(Object.keys(response.body.data).sort(), ['changed', 'id', 'revision', 'scopes']);
  assert.equal(response.body.data.id, TARGET_ID);
  assert.deepEqual(response.body.data.scopes, ['audit:read', 'sources:read'], '去重 + 码元序');
  assert.equal(response.body.data.changed, true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'grant');
  assert.deepEqual(
    { ...calls[0].action, auditId: '<uuid>' },
    {
      actorId: ACTOR_ID,
      auditId: '<uuid>',
      targetId: TARGET_ID,
      scope: 'audit:read',
      reason: '轮班交接：需要审计读权限',
      requestId: makeUuid(890),
      expectedRevision: 3,
    },
    'CAS 的 expectedRevision 必须来自 If-Match，不是服务层自己猜的当前值',
  );
  assert.match(calls[0].action.auditId, /^[0-9a-f-]{36}$/, '审计 id 由调用方生成（撞主键是可复现的失败注入点）');
});

test('撤销：200；scope 从**路径**来（不是查询参数、也不是 body）', async () => {
  const { authority, calls } = fakeAuthority({ scopes: ['audit:read', 'sources:read'], revision: 3 });
  const service = serviceWith({ scopeAuthority: authority });

  const response = await service.revokeAdministratorScope(
    writeContext(),
    TARGET_ID,
    'audit:read',
    { reason: '离岗交接，收回审计读' },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.scopes, ['sources:read']);
  assert.equal(calls[0].kind, 'revoke');
  assert.equal(calls[0].action.scope, 'audit:read');
  // 幂等键域必须带真实 scope ⇒ 撤 A 与撤 B 不会互相串键重放。
  assert.equal(calls[0].action.targetId, TARGET_ID);
});

test('幂等重放：同键同体第二次命中已定型结果，写权威**只被调用一次**', async () => {
  const { authority, calls } = fakeAuthority({ scopes: [], revision: 2 });
  const service = serviceWith({ scopeAuthority: authority });

  const first = await service.grantAdministratorScope(writeContext(), TARGET_ID, grantBody());
  const second = await service.grantAdministratorScope(writeContext(), TARGET_ID, grantBody());

  assert.deepEqual(second.body, first.body, '重放必须原样回放第一次的结果');
  assert.equal(second.headers.ETag, first.headers.ETag);
  assert.equal(calls.length, 1, '同键同体不得再触达写权威（否则会多一条审计、多一次 revision 前进）');
});

test('同键异体 ⇒ 409 IDEMPOTENCY_CONFLICT（不得把两次不同请求合并）', async () => {
  const { authority } = fakeAuthority({ scopes: [] });
  const service = serviceWith({ scopeAuthority: authority });

  await service.grantAdministratorScope(writeContext(), TARGET_ID, grantBody());
  const error = await expectApiError(
    () => service.grantAdministratorScope(writeContext(), TARGET_ID, grantBody({ scope: 'flags:read' })),
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(error.status, 409);
});

// ---------------------------------------------------------------- 权限矩阵

test('缺 scopes:write ⇒ 403 SCOPE_DENIED，写权威一次都不被触达', async () => {
  for (const scopes of [['scopes:read'], ['accounts:read', 'accounts:suspend'], []]) {
    const { authority, calls } = fakeAuthority({ scopes: [] });
    const service = serviceWith({ scopeAuthority: authority });
    const ctx = { ...writeContext(), identity: opsIdentity({ userId: ACTOR_ID, scopes }) };

    const grantError = await expectApiError(() => service.grantAdministratorScope(ctx, TARGET_ID, grantBody()), 'SCOPE_DENIED');
    assert.equal(grantError.status, 403);
    const revokeError = await expectApiError(
      () => service.revokeAdministratorScope(ctx, TARGET_ID, 'audit:read', { reason: 'r' }),
      'SCOPE_DENIED',
    );
    assert.equal(revokeError.status, 403);
    assert.equal(calls.length, 0, '越权请求不得触达写权威');
  }
});

test('scopes:read 不等于 scopes:write：同一操作者读得到，却写不了（裁定②的两种能力）', async () => {
  const { authority, calls } = fakeAuthority({ scopes: [] });
  const service = createAdminOpsService({
    store: createAdminOpsStore(),
    now: () => new Date('2026-10-26T00:00:00.000Z'),
    signingKey: OPS_SIGNING_KEY,
    scopeAuthority: authority,
  });
  const ctx = { ...writeContext(), identity: opsIdentity({ userId: ACTOR_ID, scopes: ['scopes:read'] }) };
  const error = await expectApiError(() => service.grantAdministratorScope(ctx, TARGET_ID, grantBody()), 'SCOPE_DENIED');
  assert.equal(error.status, 403);
  assert.equal(calls.length, 0);
});

test('禁止自授：403 SELF_SCOPE_GRANT_DENIED（retryable:false），且不触达写权威', async () => {
  const { authority, calls } = fakeAuthority({ scopes: ['scopes:write'] });
  const service = serviceWith({ scopeAuthority: authority });

  const error = await expectApiError(
    () => service.grantAdministratorScope(writeContext(), ACTOR_ID, grantBody({ scope: 'scopes:write' })),
    'SELF_SCOPE_GRANT_DENIED',
  );
  assert.equal(error.status, 403);
  assert.equal(error.retryable, false, '这是硬规则（裁定④），重试永远不会成功');
  assert.equal(calls.length, 0, '自授必须在进入事务之前就被拦住');
});

test('允许自撤（裁定④）：同一个人对自己 DELETE 不报 403，走真实写权威', async () => {
  const { authority, calls } = fakeAuthority({ scopes: ['scopes:write', 'audit:read'] });
  const service = serviceWith({ scopeAuthority: authority });

  const response = await service.revokeAdministratorScope(writeContext(), ACTOR_ID, 'audit:read', { reason: '自降权' });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action.targetId, ACTOR_ID);
});

// ---------------------------------------------------------------- 库层 G 码 → HTTP

test('G0011（只能授予自己持有的 scope）⇒ 403 SCOPE_DENIED，且 details 指出是 scope 的问题', async () => {
  const { pool } = failingPool('G0011');
  const authority = createPostgresAdminScopeAuthority({ pool });
  const service = serviceWith({ scopeAuthority: authority });

  const error = await expectApiError(() => service.grantAdministratorScope(writeContext(), TARGET_ID, grantBody()), 'SCOPE_DENIED');
  assert.equal(error.status, 403);
  assert.deepEqual(error.details, [{ field: 'scope', code: 'not_held' }], '措辞必须与"你缺 scopes:write"区分开');
});

test('G0002（目标不存在）⇒ 404 NOT_FOUND', async () => {
  const { pool } = failingPool('G0002');
  const service = serviceWith({ scopeAuthority: createPostgresAdminScopeAuthority({ pool }) });
  const error = await expectApiError(() => service.grantAdministratorScope(writeContext(), MISSING_ID, grantBody()), 'NOT_FOUND');
  assert.equal(error.status, 404);
});

test('G0003（If-Match 与 revision 不符）⇒ 409 REVISION_CONFLICT', async () => {
  const { pool } = failingPool('G0003');
  const service = serviceWith({ scopeAuthority: createPostgresAdminScopeAuthority({ pool }) });
  const error = await expectApiError(
    () => service.revokeAdministratorScope(writeContext(), TARGET_ID, 'audit:read', { reason: 'r' }),
    'REVISION_CONFLICT',
  );
  assert.equal(error.status, 409);
});

test('G0004（目标非 active）⇒ 409 OBJECT_UNAVAILABLE', async () => {
  const { pool } = failingPool('G0004');
  const service = serviceWith({ scopeAuthority: createPostgresAdminScopeAuthority({ pool }) });
  const error = await expectApiError(() => service.grantAdministratorScope(writeContext(), TARGET_ID, grantBody()), 'OBJECT_UNAVAILABLE');
  assert.equal(error.status, 409);
});

test('G0009（撤销最后一个 scopes:write 持有者）⇒ 409 LAST_SCOPE_MANAGER，retryable:false', async () => {
  const { pool } = failingPool('G0009');
  const service = serviceWith({ scopeAuthority: createPostgresAdminScopeAuthority({ pool }) });
  const error = await expectApiError(
    () => service.revokeAdministratorScope(writeContext(), TARGET_ID, 'scopes:write', { reason: 'r' }),
    'LAST_SCOPE_MANAGER',
  );
  assert.equal(error.status, 409, '裁定⑤：硬拦，不是静默成功、也不是 400');
  assert.equal(error.retryable, false, '重试同一请求仍会归零 ⇒ 必须标不可重试');
  assert.match(error.message, /scopes:write/);
});

test('G0001 ⇒ 400、G0010 ⇒ 403、G0008 ⇒ 403，与映射表逐条一致', async () => {
  const table = [
    ['G0001', 'INVALID_REQUEST', 400],
    ['G0010', 'SCOPE_DENIED', 403],
    ['G0008', 'SELF_SCOPE_GRANT_DENIED', 403],
  ];
  for (const [sqlState, code, status] of table) {
    const error = (() => {
      try {
        mapAdminScopeAuthorityError(Object.assign(new Error('synthetic'), { code: sqlState }));
      } catch (thrown) {
        return thrown;
      }
      throw new Error(`${sqlState} 没有被映射`);
    })();
    assert.equal(error.code, code, `${sqlState} 应映射为 ${code}`);
    assert.equal(error.status, status);
    // G0008 与 G0009 同形：契约写死 `retryable:false`（裁定⑥）。没有这一条时把 G0008 的
    // retryable 改成 true 也全绿——那是个假绿：自授是硬规则，重试永远不会成功。
    assert.equal(error.retryable, false, `${sqlState} 是 4xx 客户端错误，重试同一请求仍会被拒`);
  }
});

test('权限/函数缺失（42501 / 42883）、审计 id 撞主键（23505）、G0012 ⇒ 503；超时 ⇒ 504 可重试', async () => {
  for (const sqlState of ['42501', '42883', '23505', 'G0012']) {
    const { pool } = failingPool(sqlState);
    const service = serviceWith({ scopeAuthority: createPostgresAdminScopeAuthority({ pool }) });
    const error = await expectApiError(() => service.grantAdministratorScope(writeContext(), TARGET_ID, grantBody()), 'PROVIDER_UNAVAILABLE');
    assert.equal(error.status, 503, `${sqlState} 不得降级、不得改走别的路径`);
    assert.equal(error.retryable, false);
  }
  for (const sqlState of ['57014', '55P03']) {
    const { pool } = failingPool(sqlState);
    const service = serviceWith({ scopeAuthority: createPostgresAdminScopeAuthority({ pool }) });
    const error = await expectApiError(() => service.grantAdministratorScope(writeContext(), TARGET_ID, grantBody()), 'PROVIDER_TIMEOUT');
    assert.equal(error.status, 504);
    assert.equal(error.retryable, true, '语句/锁超时是瞬时态，同一请求稍后重试可能成功');
  }
});

// ---------------------------------------------------------------- 形态与入参

test('CAS：缺 If-Match ⇒ 428 REVISION_REQUIRED；非法 ⇒ 400；都好但值不同 ⇒ 仍交给库层判', async () => {
  const { authority } = fakeAuthority({ scopes: [] });
  const service = serviceWith({ scopeAuthority: authority });

  const missing = await expectApiError(
    () => service.grantAdministratorScope({ ...writeContext(), ifMatch: undefined }, TARGET_ID, grantBody()),
    'REVISION_REQUIRED',
  );
  assert.equal(missing.status, 428);

  for (const bad of ['*', '3', '"0"', '"abc"']) {
    const error = await expectApiError(
      () => service.grantAdministratorScope({ ...writeContext(), ifMatch: bad }, TARGET_ID, grantBody()),
      'INVALID_REQUEST',
    );
    assert.equal(error.status, 400);
  }
});

test('缺 Idempotency-Key ⇒ 400 IDEMPOTENCY_KEY_REQUIRED（写面一批到底，不留半个副作用）', async () => {
  const { authority, calls } = fakeAuthority({ scopes: [] });
  const service = serviceWith({ scopeAuthority: authority });
  const error = await expectApiError(
    () => service.grantAdministratorScope({ ...writeContext(), idempotencyKey: undefined }, TARGET_ID, grantBody()),
    'IDEMPOTENCY_KEY_REQUIRED',
  );
  assert.equal(error.status, 400);
  assert.equal(calls.length, 0);
});

test('请求体按契约镜像校验：缺 reason / 多字段 / 闭集外 scope 都 400，且不触达写权威', async () => {
  const { authority, calls } = fakeAuthority({ scopes: [] });
  const service = serviceWith({ scopeAuthority: authority });
  const bad = [
    { scope: 'audit:read' },
    { scope: 'audit:read', reason: '' },
    { scope: 'audit:read', reason: 'r', extra: 1 },
    { scope: 'scopes:grant', reason: 'r' },
    { reason: 'r' },
  ];
  for (const body of bad) {
    const error = await expectApiError(() => service.grantAdministratorScope(writeContext(), TARGET_ID, body), 'INVALID_REQUEST');
    assert.equal(error.status, 400, `应拒绝：${JSON.stringify(body)}`);
  }
  assert.equal(calls.length, 0);
});

test('撤销的 scope 是路径参数：闭集外/空串 ⇒ 400 INVALID_REQUEST（⛔ 不静默当成没要撤的）', async () => {
  const { authority, calls } = fakeAuthority({ scopes: [] });
  const service = serviceWith({ scopeAuthority: authority });
  for (const badScope of ['scopes:grant', 'root', '', 'AUDIT:READ']) {
    const error = await expectApiError(
      () => service.revokeAdministratorScope(writeContext(), TARGET_ID, badScope, { reason: 'r' }),
      'INVALID_REQUEST',
    );
    assert.equal(error.status, 400, `闭集外的 ${JSON.stringify(badScope)} 必须 400`);
    assert.deepEqual(error.details, [{ field: 'scope', code: 'enum' }]);
  }
  assert.equal(calls.length, 0);
});

test('非法 uuid 路径 id ⇒ 400（形态校验先于接线状态：未接线时也仍是 400 而不是 503）', async () => {
  const unwired = createAdminOpsService({
    store: createAdminOpsStore(),
    now: () => new Date('2026-10-26T00:00:00.000Z'),
    signingKey: OPS_SIGNING_KEY,
  });
  for (const bad of ['not-a-uuid', '123']) {
    const error = await expectApiError(() => unwired.grantAdministratorScope(writeContext(), bad, grantBody()), 'INVALID_REQUEST');
    assert.equal(error.status, 400);
  }
});

// ---------------------------------------------------------------- 出口守卫

test('写权威回传闭集外 scope ⇒ 503（⛔ 不静默丢弃、⛔ 不原样照抄给调用方）', async () => {
  for (const bad of ['scopes:grant', 'root']) {
    const authority = {
      persistent: true,
      async grant(action) {
        return { administratorId: action.targetId, revision: 2, scopes: [bad], changed: true, auditId: makeUuid(881) };
      },
      async revoke() {
        throw new Error('not used');
      },
    };
    const service = serviceWith({ scopeAuthority: authority });
    const error = await expectApiError(() => service.grantAdministratorScope(writeContext(), TARGET_ID, grantBody()), 'PROVIDER_UNAVAILABLE');
    assert.equal(error.status, 503);
    assert.equal(error.retryable, false);
    assert.match(error.message, /scope/, '错误信息要指出问题在 scope，便于值班定位');
  }
});

test('写权威回传 changed 与 audit_id 不自洽 ⇒ 503（⛔ 不把读不懂的返回当成成功）', async () => {
  // 这条判据在**适配层**（`scope-authority-pg.ts` 的 `toOutcome()`）：它把函数返回的 jsonb 当
  // 外部输入，形状/自洽性不过就 fail-closed。用真 pool 替身走一遍，证明它真的会拦。
  const cases = [
    // 声称"改了"却没有审计 id —— 要么库没写审计，要么端口读错了，都不能当成功。
    { changed: true, audit_id: null, scopes: [], revision: 2 },
    // 声称"没改"却带着审计 id —— 同样不可信（幂等分支不该产生审计行）。
    { changed: false, audit_id: makeUuid(882), scopes: [], revision: 2 },
    // 形状不对。
    { changed: 'yes', audit_id: null, scopes: [], revision: 2 },
    { changed: false, audit_id: null, scopes: 'audit:read', revision: 2 },
    { changed: false, audit_id: null, scopes: [], revision: 0 },
  ];
  for (const payload of cases) {
    const { pool } = poolReturning({
      admin_id: TARGET_ID,
      ...payload,
    });
    const service = serviceWith({ scopeAuthority: createPostgresAdminScopeAuthority({ pool }) });
    const error = await expectApiError(
      () => service.grantAdministratorScope(writeContext(), TARGET_ID, grantBody()),
      'PROVIDER_UNAVAILABLE',
    );
    assert.equal(error.status, 503, `不可信返回必须 503：${JSON.stringify(payload)}`);
    assert.equal(error.retryable, false);
  }
});

// ---------------------------------------------------------------- 未接线 fail-closed

test('未接线（无写权威）⇒ 503 PROVIDER_UNAVAILABLE retryable:false；不返回成功封套、不占幂等位', async () => {
  const service = createAdminOpsService({
    store: createAdminOpsStore(),
    now: () => new Date('2026-10-26T00:00:00.000Z'),
    signingKey: OPS_SIGNING_KEY,
    scopeAuthority: null,
  });

  const grantError = await expectApiError(() => service.grantAdministratorScope(writeContext(), TARGET_ID, grantBody()), 'PROVIDER_UNAVAILABLE');
  assert.equal(grantError.status, 503);
  assert.equal(grantError.retryable, false, '接线是运维动作，重试不会成功');
  assert.match(grantError.message, /尚未接线/);

  const revokeError = await expectApiError(
    () => service.revokeAdministratorScope(writeContext(), TARGET_ID, 'audit:read', { reason: 'r' }),
    'PROVIDER_UNAVAILABLE',
  );
  assert.equal(revokeError.status, 503);

  // 幂等位没被占用：接上写权威后，**同一个键**仍应正常生效（不是 REQUEST_IN_PROGRESS / 重放）。
  const { authority, calls } = fakeAuthority({ scopes: [] });
  const wired = createAdminOpsService({
    store: createAdminOpsStore(),
    now: () => new Date('2026-10-26T00:00:00.000Z'),
    signingKey: OPS_SIGNING_KEY,
    scopeAuthority: authority,
  });
  const ok = await wired.grantAdministratorScope(writeContext(), TARGET_ID, grantBody());
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 1);
});

test('real 模式无库池 ⇒ 两条路由 503（措辞与既有 fail-closed 同源，不伪造成功）', async () => {
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig({
      APP_EXECUTION_MODE: 'real',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
      SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
      DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
      WECHAT_APP_ID: 'synthetic-not-a-real-appid',
      WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
      OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
      OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
      OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
      OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
    }),
    // **显式无库池**：这才是"real 模式但没接数据库"的诚实形态（给它一个连不上的 URL 只是
    // 把同一件事变成超时噪声）。⛔ 不用"注入一个坏 pool"来假装这条臂。
    pool: null,
    store: authStore,
  });
  try {
    const adminId = await authStore.createAdmin({
      loginName: 'scope-write-real',
      credentialHash: 'synthetic-not-a-real-credential-hash',
      scopes: [...ADMIN_SCOPES],
    });
    const token = mintOpaqueToken();
    await authStore.createSession({
      userId: adminId, tokenHashHex: hashToken(token), authEpoch: 1,
      expiresAt: new Date(Date.now() + 3600 * 1000), audience: 'admin',
    });
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': 'scope-write-real-0001',
      'if-match': '"1"',
    };
    const res = await app.inject({
      method: 'POST',
      url: `${API}/admin/administrators/${TARGET_ID}/scopes`,
      headers,
      payload: grantBody(),
    });
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(res.json().error.retryable, false);
    assert.equal(res.json().data, undefined, '⛔ 不得返回成功封套');

    const del = await app.inject({
      method: 'DELETE',
      url: `${API}/admin/administrators/${TARGET_ID}/scopes/audit:read`,
      headers: { ...headers, 'idempotency-key': 'scope-write-real-0002' },
      payload: { reason: 'r' },
    });
    assert.equal(del.statusCode, 503, del.body);
    assert.equal(del.json().error.code, 'PROVIDER_UNAVAILABLE');
  } finally {
    await app.close();
  }
});

test('stub 模式无持久端口 ⇒ 同样 503（⛔ 没有"演示成功"分支，也没有内存写路径）', async () => {
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store: authStore,
  });
  try {
    const adminId = await authStore.createAdmin({
      loginName: 'scope-write-stub',
      credentialHash: 'synthetic-not-a-real-credential-hash',
      scopes: [...ADMIN_SCOPES],
    });
    const token = mintOpaqueToken();
    await authStore.createSession({
      userId: adminId, tokenHashHex: hashToken(token), authEpoch: 1,
      expiresAt: new Date(Date.now() + 3600 * 1000), audience: 'admin',
    });
    const res = await app.inject({
      method: 'POST',
      url: `${API}/admin/administrators/${TARGET_ID}/scopes`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'scope-write-stub-0001',
        'if-match': '"1"',
      },
      payload: grantBody(),
    });
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().error.retryable, false);
    // 内存审计台账必须**零新增**：没有"先记一笔再说"的副作用。
    assert.equal(app.adminOpsService.store.audit.list().length, 0, 'fail-closed 不得留下审计');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- 契约与路由表一致性

test('两个端点同时出现在契约（openapi + operations.json）与路由表里', () => {
  // ① 契约 paths：授予是 POST（复用 `/admin/administrators/{id}/scopes` 这个 path 键），
  //    撤销是 DELETE，且 **scope 在路径里**。
  const scopesPath = openapi.paths['/admin/administrators/{id}/scopes'];
  assert.ok(scopesPath, '契约必须有 /admin/administrators/{id}/scopes');
  assert.equal(scopesPath.post?.operationId, 'grantAdministratorScope');
  assert.equal(scopesPath.get?.operationId, 'listAdministratorScopes', '读面 get 不得被写面顶掉');
  const revokePath = openapi.paths['/admin/administrators/{id}/scopes/{scope}'];
  assert.ok(revokePath, '契约必须有 /admin/administrators/{id}/scopes/{scope}');
  assert.equal(revokePath.delete?.operationId, 'revokeAdministratorScope');
  // scope 必须是**路径参数**（⛔ 不是查询参数）—— 这是裁定③的形态。
  const scopeParam = revokePath.delete.parameters.find((p) => p.name === 'scope');
  assert.equal(scopeParam?.in, 'path');
  assert.equal(scopeParam?.required, true);
  assert.deepEqual(scopeParam?.schema, { $ref: '#/components/schemas/AdminScope' });

  // ② 门与版本语义：都是 scopes:write，且都要版本（x-version-required）。
  for (const op of [scopesPath.post, revokePath.delete]) {
    assert.equal(op['x-scope'], 'scopes:write');
    assert.equal(op['x-version-required'], true);
    const names = op.parameters.map((p) => p.$ref ?? p.name);
    assert.ok(names.includes('#/components/parameters/IdempotencyKey'), '幂等键必填');
    assert.ok(names.includes('#/components/parameters/IfMatch'), 'If-Match 必填');
    assert.ok(op.requestBody?.required === true, '请求体必填');
  }
  // 授予面请求体是「单个 scope + 原因」，⛔ 不是整个集合。
  assert.equal(scopesPath.post.requestBody.content['application/json'].schema.$ref, '#/components/schemas/AdminScopeGrantInput');
  const grantInput = openapi.components.schemas.AdminScopeGrantInput;
  assert.deepEqual([...grantInput.required].sort(), ['reason', 'scope']);
  assert.equal(grantInput.additionalProperties, false);

  // ③ 两个新错误码在契约闭集里，且状态映射正确。
  const codes = openapi.components.schemas.ErrorCode.enum;
  assert.ok(codes.includes('SELF_SCOPE_GRANT_DENIED'));
  assert.ok(codes.includes('LAST_SCOPE_MANAGER'));
  // 两个错误响应必须在**两个**新操作里都声明（403 / 409）。
  for (const op of [scopesPath.post, revokePath.delete]) {
    assert.notEqual(op.responses['403'], undefined, '403 必须显式声明');
    assert.notEqual(op.responses['409'], undefined, '409 必须显式声明');
  }
  assert.match(scopesPath.post.responses['403'].description, /SELF_SCOPE_GRANT_DENIED/);
  assert.match(revokePath.delete.responses['409'].description, /LAST_SCOPE_MANAGER/);
  assert.match(scopesPath.post.responses['409'].description, /LAST_SCOPE_MANAGER/, '授予面也要声明该码（口径一致，避免读契约的人以为只有撤销会返回它）');

  // ④ operations.json：两条 operation 都要登记，scope = scopes:write。
  const byId = new Map(operations.operations.map((o) => [o.id, o]));
  assert.equal(byId.get('grantAdministratorScope')?.scope, 'scopes:write');
  assert.equal(byId.get('grantAdministratorScope')?.method, 'post');
  assert.equal(byId.get('revokeAdministratorScope')?.scope, 'scopes:write');
  assert.equal(byId.get('revokeAdministratorScope')?.method, 'delete');
  assert.equal(byId.get('revokeAdministratorScope')?.path, '/admin/administrators/{id}/scopes/{scope}');

  // ⑤ 路由清单：两条都在 `ADMIN_HTTP_OPERATION_IDS`，且门取自 `OPS_SCOPES`（单一来源）。
  assert.ok(ADMIN_HTTP_OPERATION_IDS.includes('grantAdministratorScope'));
  assert.ok(ADMIN_HTTP_OPERATION_IDS.includes('revokeAdministratorScope'));
  assert.equal(OPS_SCOPES.grantAdministratorScope, 'scopes:write');
  assert.equal(OPS_SCOPES.revokeAdministratorScope, 'scopes:write');
});

test('装配后的 app 真的注册了两条路由（方法/路径与契约逐字一致）', async () => {
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store: createMemoryAuthStore(),
  });
  try {
    assert.equal(app.hasRoute({ method: 'POST', url: `${API}/admin/administrators/:id/scopes` }), true);
    assert.equal(app.hasRoute({ method: 'DELETE', url: `${API}/admin/administrators/:id/scopes/:scope` }), true);
    // 撤销面的 scope **在路径里**：不带 :scope 的 DELETE 不得存在。
    assert.equal(app.hasRoute({ method: 'DELETE', url: `${API}/admin/administrators/:id/scopes` }), false);
    // 两条都**不得**挂到 /admin/accounts 名下（裁定③：那是 users.id 的目录）。
    assert.equal(app.hasRoute({ method: 'POST', url: `${API}/admin/accounts/:id/scopes` }), false);
    assert.equal(app.hasRoute({ method: 'DELETE', url: `${API}/admin/accounts/:id/scopes/:scope` }), false);
  } finally {
    await app.close();
  }
});

test('闭集镜像：契约 AdminScope enum 与 admin/scopes.ts 的 ADMIN_SCOPES 逐项一致', () => {
  assert.deepEqual(openapi.components.schemas.AdminScope.enum, [...ADMIN_SCOPES]);
  // 撤销路径参数的 schema 必须引用同一个具名 schema（不是另抄一份内联 enum）。
  assert.deepEqual(openapi.components.schemas.AdminScopeGrantInput.properties.scope, {
    $ref: '#/components/schemas/AdminScope',
  });
});

/** 造一个必定在函数调用处失败的 pool（用于 G 码映射；`BEGIN`/`SET LOCAL`/`ROLLBACK` 正常返回）。 */
function failingPool(sqlState) {
  const calls = [];
  const client = {
    async query(text) {
      calls.push(text);
      if (text === 'BEGIN' || text === 'ROLLBACK' || text.startsWith('SET LOCAL')) return { rows: [] };
      const error = new Error('synthetic pg failure');
      error.code = sqlState;
      throw error;
    },
    release() {},
  };
  return { calls, pool: { async connect() { return client; } } };
}

/** 造一个"调用成功、但回传指定 result"的 pool（用于出口形状守卫）。 */
function poolReturning(result) {
  const calls = [];
  const client = {
    async query(text) {
      calls.push(text);
      if (text === 'BEGIN' || text === 'ROLLBACK' || text.startsWith('SET LOCAL')) return { rows: [] };
      return { rows: [{ result }] };
    },
    release() {},
  };
  return { calls, pool: { async connect() { return client; } } };
}
