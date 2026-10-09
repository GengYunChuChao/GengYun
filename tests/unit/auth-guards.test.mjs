import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyIdentity,
  currentIdentity,
  readIdentity,
  requireOwnership,
  requireScope,
} from '../../services/api/src/auth/middleware.ts';
import { ApiError } from '../../services/api/src/errors.ts';
import { isPositiveInteger } from '../../services/api/src/auth/tokens.ts';

/**
 * 这些是 GY-I27（packages/privacy）`requireConsent` 将要消费的接口缝语义：
 * 缺 authEpoch → SESSION_REQUIRED；非正整数 → INVALID_REQUEST；
 * 与账号当前 auth_epoch 不一致 → ACCOUNT_INACTIVE（由鉴权阶段判定，见 middleware）。
 */

function assertApiError(code, status) {
  return (error) => {
    assert.ok(error instanceof ApiError, `应为 ApiError，实际：${error}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  };
}

test('applyIdentity 填充 req.userId / req.authEpoch（正整数）/ req.role，并可通过 readIdentity 还原', () => {
  const request = {};
  applyIdentity(request, {
    userId: 'user-9',
    authEpoch: 7,
    role: 'admin',
    sessionId: 'session-1',
    expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    revision: 3,
    scopes: ['session:read'],
  });
  assert.equal(request.userId, 'user-9');
  assert.equal(request.authEpoch, 7);
  assert.equal(request.role, 'admin');
  assert.equal(request.sessionId, 'session-1');
  assert.equal(request.accountRevision, 3);
  assert.deepEqual(request.authScopes, ['session:read']);
  assert.deepEqual(readIdentity(request), { userId: 'user-9', authEpoch: 7, role: 'admin' });
  assert.deepEqual(currentIdentity(request).scopes, ['session:read']);
});

test('用户会话的 authScopes 为 null（用户不携带后台 scope）', () => {
  const request = {};
  applyIdentity(request, {
    userId: 'user-1',
    authEpoch: 2,
    role: 'user',
    sessionId: 's',
    expiresAt: new Date(0),
    revision: 1,
    scopes: ['user'],
  });
  assert.equal(request.authScopes, null);
  assert.deepEqual(currentIdentity(request).scopes, ['user']);
});

test('readIdentity：缺 userId / 缺 authEpoch / 缺角色 → 401 SESSION_REQUIRED', () => {
  assert.throws(() => readIdentity({ userId: null, authEpoch: null, role: null }), assertApiError('SESSION_REQUIRED', 401));
  assert.throws(() => readIdentity({ userId: 'u', authEpoch: null, role: 'user' }), assertApiError('SESSION_REQUIRED', 401));
  assert.throws(() => readIdentity({ userId: 'u', authEpoch: undefined, role: 'user' }), assertApiError('SESSION_REQUIRED', 401));
  assert.throws(() => readIdentity({ userId: '', authEpoch: 1, role: 'user' }), assertApiError('SESSION_REQUIRED', 401));
  assert.throws(() => readIdentity({ userId: 'u', authEpoch: 1, role: null }), assertApiError('SESSION_REQUIRED', 401));
});

test('readIdentity：authEpoch 非正整数 → 400 INVALID_REQUEST', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => readIdentity({ userId: 'u', authEpoch: bad, role: 'user' }),
      assertApiError('INVALID_REQUEST', 400),
    );
  }
  assert.equal(isPositiveInteger(1), true);
  assert.equal(isPositiveInteger(0), false);
  assert.deepEqual(readIdentity({ userId: 'u', authEpoch: 4, role: 'admin' }), { userId: 'u', authEpoch: 4, role: 'admin' });
});

test('requireOwnership：本人记录通过；非本人记录对外表现为 NOT_FOUND（不泄露存在性）', () => {
  const request = { userId: 'owner-1', authEpoch: 1, role: 'user' };
  assert.doesNotThrow(() => requireOwnership(request, 'owner-1'));
  assert.throws(() => requireOwnership(request, 'owner-2'), assertApiError('NOT_FOUND', 404));
  assert.throws(
    () => requireOwnership({ userId: null, authEpoch: null, role: null }, 'owner-1'),
    assertApiError('SESSION_REQUIRED', 401),
  );
});

test('requireScope：具备 scope 通过；缺少 → 403 SCOPE_DENIED；用户会话无 scope 亦拒绝', () => {
  assert.doesNotThrow(() => requireScope({ authScopes: ['session:read'] }, 'session:read'));
  assert.throws(() => requireScope({ authScopes: [] }, 'session:logout'), assertApiError('SCOPE_DENIED', 403));
  assert.throws(() => requireScope({ authScopes: null }, 'session:read'), assertApiError('SCOPE_DENIED', 403));
  assert.throws(() => requireScope({}, 'session:read'), assertApiError('SCOPE_DENIED', 403));
});

test('currentIdentity：缺少会话上下文（sessionId/到期/revision）→ 401 SESSION_REQUIRED', () => {
  assert.throws(
    () => currentIdentity({ userId: 'u', authEpoch: 1, role: 'user', sessionId: null, sessionExpiresAt: null, accountRevision: null }),
    assertApiError('SESSION_REQUIRED', 401),
  );
});
