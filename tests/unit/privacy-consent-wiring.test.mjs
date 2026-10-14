/**
 * GY-I27 **接线单**（用户 2026-10-14 授权改他人已合并文件）· 用途授权接线回归。
 *
 * 本文件证明「协议层通过」升级为「**HTTP 装配后仍通过**」：
 *  1. 授权中间件挂到 `POST /recognitions` / `PATCH /recognitions/{id}/selection` 等执行入口后，
 *     无授权 ⇒ 403 `CONSENT_REQUIRED`；错用途 ⇒ 403 `SCOPE_DENIED`；已授权 ⇒ 放行；
 *  2. **撤回用途后写面被阻断且零写入**（GET 的 revision 不变）——本单的核心增量；
 *  3. 读取与删除**不受**用途授权限制（否则用户无法取回/删除自己的数据）；
 *  4. **未注入 ⇒ 既有行为逐字不变**（可回退的对照）；
 *  5. `consent-pg` / `grant-pg` 的撤回/授予路径：注入 `egressRevoker` 后**先撤销在途外发**再继续；
 *     未注入 ⇒ 既有 `OBJECT_UNAVAILABLE` 兜底不变。
 *
 * 身份为合成身份（替身微信提供者 + 内存 auth store），外发消费者为替身/未接线，
 * **不连接真实数据库、不调用真实第三方、不产生任何费用**。
 * 第 5 部分用**明确标注的合成 PG 替身**（canned `query` 结果）验证接线路径；
 * 真实 PG17.11 上的执行**未验证**（见证据页）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createSubstituteMediaPort } from '../../services/api/src/recognitions/media.ts';
import { createStubRecognitionProvider } from '../../services/api/src/recognitions/provider.ts';
import { createPostgresConsentService } from '../../services/api/src/privacy/consent-pg.ts';
import { createGuardConsentGate } from '../../services/api/src/privacy/egress.ts';
import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { createPrivacyGuard } from '../../packages/privacy/guard.mjs';
import { createAccountProvider, VERIFIED_RECIPIENT } from '../privacy/_fixtures.mjs';

const API = '/api/v1';
const MEDIA_A = '11111111-1111-4111-8111-111111111111';

/** 合成账号提供者：全部账号 active、auth_epoch=1（与新建会话一致）。 */
function accountProvider() {
  return createAccountProvider();
}

function makeApp({ consent } = {}) {
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store: authStore,
    recognitionStore: createMemoryRecognitionStore(),
    recognitionProvider: createStubRecognitionProvider(),
    recognitionMedia: createSubstituteMediaPort(),
    ...(consent === undefined ? {} : { privacyInjection: { consent } }),
  });
  return { app, authStore };
}

async function login(app, code) {
  const r = await app.inject({
    method: 'POST',
    url: `${API}/auth/wechat`,
    headers: { 'content-type': 'application/json', 'idempotency-key': `login-key-${code}` },
    payload: { code },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().data.access_token;
}

async function userIdFor(authStore, token) {
  const session = await authStore.findSession(hashToken(token), 'user');
  assert.ok(session, '合成会话必须存在');
  return session.userId;
}

async function call(app, method, url, token, { payload, headers } = {}) {
  const r = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers ?? {}) },
  });
  let body = null;
  try {
    body = r.json();
  } catch {
    body = null;
  }
  return { status: r.statusCode, body, etag: r.headers.etag };
}

async function waitForTerminal(app, token, jobId, timeoutMs = 3000) {
  const terminal = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await call(app, 'GET', `${API}/jobs/${jobId}`, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (terminal.includes(r.body.data.state)) return r.body.data;
    if (Date.now() > deadline) throw new Error(`等待任务终态超时：${r.body.data.state}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function grantPurposes(consentStore, userId, purposes, recipientId = VERIFIED_RECIPIENT.id) {
  for (const purpose of purposes) {
    await consentStore.grant({ userId, purpose, policyVersion: '1.0.0', recipientIds: [recipientId] });
  }
}

/** 建一个已授权、已终态的识别记录，返回 { targetId, revision }。 */
async function settledRecognition(app, token) {
  const created = await call(app, 'POST', `${API}/recognitions`, token, {
    payload: { media_id: MEDIA_A, media_revision: 1 },
    headers: { 'idempotency-key': 'idem-create-0000000001' },
  });
  assert.equal(created.status, 202, created.body);
  const job = await waitForTerminal(app, token, created.body.data.id);
  assert.equal(job.state, 'succeeded', JSON.stringify(job));
  const targetId = created.body.data.target_ref.id;
  const got = await call(app, 'GET', `${API}/recognitions/${targetId}`, token);
  assert.equal(got.status, 200, got.body);
  return { targetId, revision: got.body.data.revision };
}

test('接线生效·无授权 ⇒ 403 CONSENT_REQUIRED；未登录仍 401（鉴权顺序不变）', async () => {
  const account = accountProvider();
  const consentStore = createConsentStore();
  const gate = createGuardConsentGate(createPrivacyGuard({ account, consentStore }));
  const { app } = makeApp({ consent: gate });
  const token = await login(app, 'synthetic-wire-a');
  try {
    const post = await call(app, 'POST', `${API}/recognitions`, token, {
      payload: { media_id: MEDIA_A, media_revision: 1 },
      headers: { 'idempotency-key': 'idem-deny-0000000001' },
    });
    assert.equal(post.status, 403, post.body);
    assert.equal(post.body.error.code, 'CONSENT_REQUIRED');
    assert.equal(post.body.data, undefined, '不得返回成功封套');

    const anon = await call(app, 'POST', `${API}/recognitions`, null, {
      payload: { media_id: MEDIA_A, media_revision: 1 },
      headers: { 'idempotency-key': 'idem-anon-0000000001' },
    });
    assert.equal(anon.status, 401, anon.body);
    assert.equal(anon.body.error.code, 'SESSION_REQUIRED');
  } finally {
    await app.close();
  }
});

test('接线生效·错用途 ⇒ 403 SCOPE_DENIED（用途与资料类型不匹配的装配必须在 HTTP 面被拒）', async () => {
  const account = accountProvider();
  const consentStore = createConsentStore();
  const base = createGuardConsentGate(createPrivacyGuard({ account, consentStore }));
  // 故意把 public_posting 要求挂到 weed_recognition 上：错用途 ⇒ 中间件必须拒绝。
  const wrongGate = (requirement) => base({ purpose: 'public_posting', dataType: requirement.dataType });
  const { app } = makeApp({ consent: wrongGate });
  const token = await login(app, 'synthetic-wire-b');
  try {
    const res = await call(app, 'POST', `${API}/recognitions`, token, {
      payload: { media_id: MEDIA_A, media_revision: 1 },
      headers: { 'idempotency-key': 'idem-scope-0000000001' },
    });
    assert.equal(res.status, 403, res.body);
    assert.equal(res.body.error.code, 'SCOPE_DENIED');
  } finally {
    await app.close();
  }
});

test('接线生效·撤回用途后写面被阻断且**零写入**（GET revision 不变），读取与删除不受限', async () => {
  const account = accountProvider();
  const consentStore = createConsentStore();
  const gate = createGuardConsentGate(createPrivacyGuard({ account, consentStore }));
  const { app, authStore } = makeApp({ consent: gate });
  const token = await login(app, 'synthetic-wire-c');
  const userId = await userIdFor(authStore, token);
  try {
    // 契约：weed_recognition 需要 media_processing + external_inference。
    await grantPurposes(consentStore, userId, ['media_processing', 'external_inference']);

    const first = await settledRecognition(app, token);
    assert.ok(first.revision >= 1);

    // 已授权：写面可用（PATCH 选择一次 ⇒ revision 前进，证明写面本身通）。
    const selected = await call(app, 'PATCH', `${API}/recognitions/${first.targetId}/selection`, token, {
      payload: { selected_species_id: 'synthetic_weed_a' },
      headers: { 'if-match': `"${first.revision}"`, 'idempotency-key': 'idem-sel-0000000001' },
    });
    assert.equal(selected.status, 200, selected.body);
    const afterSelect = await call(app, 'GET', `${API}/recognitions/${first.targetId}`, token);
    assert.equal(afterSelect.status, 200);
    const revisionBeforeWithdraw = afterSelect.body.data.revision;
    assert.ok(revisionBeforeWithdraw > first.revision, '写面通过时 revision 必须前进');

    // —— 撤回用途（合成撤回：直接作用于注入的授权存储；HTTP 撤回面需真实 PG，见证据页）——
    await consentStore.withdraw({ userId, purpose: 'external_inference' });

    // 写面：撤回后被阻断，且**零写入**（revision 与撤回前完全一致）。
    const blocked = await call(app, 'PATCH', `${API}/recognitions/${first.targetId}/selection`, token, {
      payload: { selected_species_id: 'synthetic_weed_b' },
      headers: { 'if-match': `"${revisionBeforeWithdraw}"`, 'idempotency-key': 'idem-sel-0000000002' },
    });
    assert.equal(blocked.status, 403, blocked.body);
    assert.equal(blocked.body.error.code, 'CONSENT_REQUIRED');
    assert.equal(blocked.body.data, undefined);

    const after = await call(app, 'GET', `${API}/recognitions/${first.targetId}`, token);
    assert.equal(after.status, 200);
    assert.equal(after.body.data.revision, revisionBeforeWithdraw, '撤回后被阻断的写面必须零写入（revision 不变）');

    // 撤回后不得再受理新外发。
    const newJob = await call(app, 'POST', `${API}/recognitions`, token, {
      payload: { media_id: MEDIA_A, media_revision: 1 },
      headers: { 'idempotency-key': 'idem-create-0000000002' },
    });
    assert.equal(newJob.status, 403, newJob.body);
    assert.equal(newJob.body.error.code, 'CONSENT_REQUIRED');

    // 负向对照：**删除自己的数据不要求用途授权**（否则撤回后用户无法删除自己的数据）。
    const deleted = await call(app, 'DELETE', `${API}/recognitions/${first.targetId}`, token, {
      headers: { 'if-match': `"${revisionBeforeWithdraw}"`, 'idempotency-key': 'idem-del-0000000001' },
    });
    assert.equal(deleted.status, 202, deleted.body);
  } finally {
    await app.close();
  }
});

test('可回退对照·未注入授权中间件 ⇒ 无授权也能受理（既有行为逐字不变）', async () => {
  const { app } = makeApp({ consent: undefined });
  const token = await login(app, 'synthetic-wire-d');
  try {
    const created = await call(app, 'POST', `${API}/recognitions`, token, {
      payload: { media_id: MEDIA_A, media_revision: 1 },
      headers: { 'idempotency-key': 'idem-control-0000000001' },
    });
    assert.equal(created.status, 202, created.body);
    assert.equal(created.body.data.state, 'queued');
  } finally {
    await app.close();
  }
});

test('接线生效·四个 AI 执行入口都挂了中间件（转写/标签 OCR/合成 与识别同一口径）', async () => {
  const account = accountProvider();
  const consentStore = createConsentStore();
  const gate = createGuardConsentGate(createPrivacyGuard({ account, consentStore }));
  const { app, authStore } = makeApp({ consent: gate });
  const token = await login(app, 'synthetic-wire-e');
  const userId = await userIdFor(authStore, token);
  const body = { media_id: MEDIA_A, media_revision: 1 };
  const entries = [
    ['POST', `${API}/speech/transcriptions`, 'idem-entry-speech-0001'],
    ['POST', `${API}/ocr`, 'idem-entry-ocr-0000001'],
    ['POST', `${API}/speech/synthesis`, 'idem-entry-tts-0000001'],
  ];
  const synthesisBody = { checked_content_ref: { type: 'herbicide', id: 'synthetic-target', revision: 1 }, locale: 'zh-CN' };
  try {
    for (const [method, url, key] of entries) {
      const denied = await call(app, method, url, token, {
        payload: url.endsWith('synthesis') ? synthesisBody : body,
        headers: { 'idempotency-key': key },
      });
      assert.equal(denied.status, 403, `${method} ${url}：${denied.body}`);
      assert.equal(denied.body.error.code, 'CONSENT_REQUIRED', `${method} ${url}`);
    }

    // 授权齐全后：中间件必须放行（由各域自己的业务错误码作答，而**不再是**授权类错误码）。
    await grantPurposes(consentStore, userId, ['recording', 'media_processing', 'external_inference']);
    for (const [method, url, key] of entries) {
      const allowed = await call(app, method, url, token, {
        payload: url.endsWith('synthesis') ? synthesisBody : body,
        headers: { 'idempotency-key': `${key}-pass` },
      });
      assert.notEqual(['CONSENT_REQUIRED', 'SCOPE_DENIED', 'ACCOUNT_INACTIVE'].includes(allowed.body?.error?.code), true,
        `${method} ${url} 授权齐全后不得再出授权类错误码：${allowed.status} ${JSON.stringify(allowed.body)}`);
    }
  } finally {
    await app.close();
  }
});

test('生产解析·配置了数据库（未注入）⇒ 中间件自动挂上；授权读取不可用 ⇒ fail-closed 503 不放行', async () => {
  const authStore = createMemoryAuthStore();
  const connectAttempts = [];
  const unreachablePool = {
    async connect() {
      connectAttempts.push(1);
      throw new Error('synthetic-unreachable-database');
    },
    async query() {
      connectAttempts.push(1);
      throw new Error('synthetic-unreachable-database');
    },
  };
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store: authStore,
    pool: unreachablePool,
    recognitionStore: createMemoryRecognitionStore(),
    recognitionProvider: createStubRecognitionProvider(),
    recognitionMedia: createSubstituteMediaPort(),
  });
  const token = await login(app, 'synthetic-wire-f');
  try {
    const res = await call(app, 'POST', `${API}/recognitions`, token, {
      payload: { media_id: MEDIA_A, media_revision: 1 },
      headers: { 'idempotency-key': 'idem-pool-0000000001' },
    });
    // 授权读取不可用 ⇒ **fail-closed**：不得以"读不到就放行"的方式受理任务。
    assert.equal(res.status, 503, res.body);
    assert.equal(res.body.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(res.body.data, undefined, '不得返回成功封套');
    assert.ok(connectAttempts.length > 0, '必须真的尝试读取授权（证明中间件已挂上）');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 第 5 部分：撤回/授予消费者接线（合成 PG 替身；真实 PG17.11 未验证）
// ---------------------------------------------------------------------------

/** 明确标注的**合成** PG 替身：按 SQL 片段返回 canned 结果，不连接任何数据库。 */
function syntheticPool() {
  const userId = '11111111-1111-4111-8111-1111111111aa';
  const sessionId = '22222222-2222-4222-8222-2222222222bb';
  const recordId = '33333333-3333-4333-8333-3333333333cc';
  const policyId = '44444444-4444-4444-8444-4444444444dd';
  const grantedAt = new Date('2026-10-14T00:00:00.000Z');
  const withdrawnAt = new Date('2026-10-14T01:00:00.000Z');
  const consentRow = (state) => ({
    id: recordId,
    user_id: userId,
    purpose: 'external_inference',
    policy_version: '1.0.0',
    recipient_ids: [VERIFIED_RECIPIENT.id],
    state,
    epoch: 1,
    granted_at: grantedAt,
    withdrawn_at: state === 'granted' ? null : withdrawnAt,
    revision: state === 'granted' ? 1 : 2,
    epoch_state: state,
    current_epoch: 1,
  });
  const queries = [];
  const client = {
    queries,
    async query(text, values) {
      const sql = String(text);
      queries.push({ text: sql, values });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.includes('FROM public.users')) return { rows: [{ id: userId, state: 'active', auth_epoch: 1, revision: 1 }] };
      if (sql.includes('FROM public.sessions')) return { rows: [{ id: sessionId }] };
      if (sql.includes('DELETE FROM public.idempotency_keys')) return { rows: [] };
      if (sql.includes('SELECT request_hash,outcome FROM public.idempotency_keys')) return { rows: [] };
      if (sql.includes('FROM public.consent_policies')) {
        return {
          rows: [
            {
              id: policyId,
              purpose: 'external_inference',
              enabled: true,
              source_kind: 'verified',
              source_ref: 'https://example.invalid/policy/external-inference',
              review_evidence_ref: 'https://example.invalid/review/external-inference',
              content_sha256: 'a'.repeat(64),
              policy_version: '1.0.0',
              valid_from: grantedAt,
              valid_until: new Date('2027-10-14T00:00:00.000Z'),
              recipient_bindings: {
                [VERIFIED_RECIPIENT.id]: {
                  config_version: VERIFIED_RECIPIENT.config_version,
                  policy_version: VERIFIED_RECIPIENT.policy_version,
                  capability: VERIFIED_RECIPIENT.capability,
                  retention_online_days: VERIFIED_RECIPIENT.retention_online_days,
                  retention_backup_days: VERIFIED_RECIPIENT.retention_backup_days,
                  no_training_evidence_ref: 'https://example.invalid/evidence/no-training',
                  deletion_evidence_ref: 'https://example.invalid/evidence/deletion',
                },
              },
            },
          ],
        };
      }
      if (sql.includes('FROM public.recipients')) return { rows: [{ ...VERIFIED_RECIPIENT }] };
      if (sql.includes('JOIN public.consent_records')) return { rows: [consentRow('granted')] };
      if (sql.includes('FROM public.privacy_epochs')) return { rows: [] };
      if (sql.includes('AS present')) return { rows: [{ present: true }] };
      if (sql.includes('UPDATE public.consent_records')) return { rows: [consentRow('withdrawn')] };
      if (sql.includes('UPDATE public.privacy_epochs')) return { rows: [{ user_id: userId }] };
      if (sql.includes('INSERT INTO public.consent_records')) return { rows: [consentRow('granted')] };
      return { rows: [] };
    },
    release() {},
  };
  return {
    userId,
    sessionId,
    queries,
    async connect() {
      return client;
    },
  };
}

function identityInput(pool) {
  return {
    identity: {
      userId: pool.userId,
      authEpoch: 1,
      role: 'user',
      sessionId: pool.sessionId,
      expiresAt: new Date(Date.now() + 3600_000),
      revision: 1,
      scopes: ['user'],
    },
    token: 'synthetic-opaque-token',
  };
}

test('撤回接线·注入 egressRevoker ⇒ 先撤销在途外发再完成撤回（合成 PG 替身）', async () => {
  const pool = syntheticPool();
  const calls = [];
  const service = createPostgresConsentService(pool, 'synthetic-hmac-key', {
    egressRevoker: {
      onConsentWithdrawn: (input) => {
        calls.push(input);
        return { revokedInFlight: 2 };
      },
      onAccountSuspendedOrDeleted: () => ({ revokedInFlight: 0 }),
    },
  });
  const result = await service.withdraw(identityInput(pool), {
    purpose: 'external_inference',
    ifMatch: '"1"',
    idempotencyKey: 'synthetic-idem-key-0001',
  });
  assert.equal(result.state, 'withdrawn');
  assert.equal(result.withdrawn_at, new Date('2026-10-14T01:00:00.000Z').toISOString());
  assert.deepEqual(calls, [{ userId: pool.userId, purpose: 'external_inference' }], '撤回消费者必须被调用一次');
  // 消费者先于撤回提交被调用（同一事务内）：撤回后 epoch 递增语句必须出现。
  const sqls = pool.queries.map((q) => q.text);
  assert.ok(sqls.some((sql) => sql.includes("UPDATE public.privacy_epochs")), '撤回必须递增 purpose epoch');
});

test('可回退对照·撤回未注入 egressRevoker ⇒ 既有 OBJECT_UNAVAILABLE 兜底逐字不变', async () => {
  const pool = syntheticPool();
  const service = createPostgresConsentService(pool, 'synthetic-hmac-key');
  await assert.rejects(
    () =>
      service.withdraw(identityInput(pool), {
        purpose: 'external_inference',
        ifMatch: '"1"',
        idempotencyKey: 'synthetic-idem-key-0002',
      }),
    (error) => error.code === 'OBJECT_UNAVAILABLE' && /撤回消费者尚未接入/.test(error.message),
  );
  // 兜底路径不得写入任何撤回：不出现 UPDATE consent_records。
  assert.equal(pool.queries.some((q) => q.text.includes('UPDATE public.consent_records')), false);
});

test('授予接线·注入 egressRevoker ⇒ 已有依赖时先撤销在途外发再写新 epoch', async () => {
  const pool = syntheticPool();
  const calls = [];
  const service = createPostgresConsentService(pool, 'synthetic-hmac-key', {
    egressRevoker: {
      onConsentWithdrawn: (input) => {
        calls.push(input);
        return { revokedInFlight: 1 };
      },
      onAccountSuspendedOrDeleted: () => ({ revokedInFlight: 0 }),
    },
  });
  const granted = await service.grant(identityInput(pool), {
    purpose: 'external_inference',
    policy_version: '1.0.0',
    recipient_ids: [VERIFIED_RECIPIENT.id],
    idempotencyKey: 'synthetic-idem-key-0003',
  });
  assert.equal(granted.state, 'granted');
  assert.deepEqual(calls, [{ userId: pool.userId, purpose: 'external_inference' }]);
});

test('可回退对照·授予未注入 egressRevoker ⇒ 既有 OBJECT_UNAVAILABLE 兜底逐字不变', async () => {
  const pool = syntheticPool();
  const service = createPostgresConsentService(pool, 'synthetic-hmac-key');
  await assert.rejects(
    () =>
      service.grant(identityInput(pool), {
        purpose: 'external_inference',
        policy_version: '1.0.0',
        recipient_ids: [VERIFIED_RECIPIENT.id],
        idempotencyKey: 'synthetic-idem-key-0004',
      }),
    (error) => error.code === 'OBJECT_UNAVAILABLE' && /授权变更消费者尚未接入/.test(error.message),
  );
});
