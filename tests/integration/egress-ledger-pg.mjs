/**
 * GY-I27（#29）第二片 · **真实 PostgreSQL** 上的外发账本端到端（真 PG，不再用合成替身）。
 *
 * 运行（本地隔离集群，仅回环；凭据只在本机 private 文件里）：
 *   DROP/CREATE DATABASE gengyun_egress_test   -- 本脚本**要求空库**（首行断言 public 无表）
 *   EGRESS_LEDGER_TEST_URL='postgres://<owner>:<pw>@127.0.0.1:55432/gengyun_egress_test' \
 *   node tests/integration/egress-ledger-pg.mjs
 *
 * 覆盖（每条都是**真库**行为，不是 canned 替身）：
 *   1. 0001/0003/0008/0009/0011 迁移 + **0011 up→down→up** 回滚演练；
 *   2. 最小权限角色 `gengyun_egress_ledger`：可登记/迁移/写回；**不可**删账本行、改冻结快照列、
 *      写 recipients/users.state、DDL；
 *   3. **实际派发**：reserve → assertExecutable → markSent → 提供者 → saveResult（写回与校验同事务）；
 *      账本如实登记 userid/purpose/recipient/job，回写只落结构分类（无私有正文）；
 *   4. 重复派发被拒（同一预留行不得二次 markSent）；
 *   5. **HTTP 撤回端到端**：撤回消费者已接线 ⇒ `DELETE /me/consents/external_inference` 返回 **200**
 *      并撤销在途外发；晚到的提供者结果**回写被阻断且零写入**；撤回后入口拒绝；
 *   6. **取消墓碑**：`POST /jobs/{id}/cancel` ⇒ 墓碑只增不减；晚到结果零写入；**同对象同版本不得再次预留**；
 *   7. `real` 未接真实传输 ⇒ **在任何账本变更之前** 503，且该用户**零 sent 记录**；
 *   8. 注销/停用（按 state-contract §105 在同一提交里 state+auth_epoch 前进）⇒ 入口拒绝 + 在途撤销
 *      + 晚到结果零写入（HTTP 触发面 `requestAccountDeletion` 仍为 planned，本脚本用契约口径模拟）。
 *
 * 不联网（除本机回环 PG）；不发任何真实第三方请求；不打印凭据。
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { createSubstituteMediaPort } from '../../services/api/src/recognitions/media.ts';
import { createPostgresExportLedger, createPostgresPrivacyPorts } from '../../services/api/src/privacy/ledger-pg.ts';
import { createEgressRevoker, createInFlightGuard } from '../../packages/privacy/in-flight.mjs';

const url = new URL(process.env.EGRESS_LEDGER_TEST_URL ?? '');
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'EGRESS_LEDGER_TEST_URL 必须是 postgres URL');
assert.equal(url.search, '');
assert.equal(url.hash, '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), '只允许回环地址');
assert.equal(url.pathname, '/gengyun_egress_test');

const owner = new pg.Client({ connectionString: url.href });
await owner.connect();
const groups = ['gengyun_auth_privacy', 'gengyun_consent_granter', 'gengyun_egress_ledger'];
const loginName = 'gengyun_egress_test';
const password = randomBytes(24).toString('hex');
const key = randomBytes(32).toString('hex');
const subject = (code) => createHmac('sha256', key).update(`synthetic\n${code}`).digest('hex');
const sqlFile = (path) => readFileSync(new URL(`../../services/api/db/${path}`, import.meta.url), 'utf8');

let app;
let realFallbackApp;
let pool;
let passed = 0;
const createdRoles = [];
const say = (label) => {
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
};
const userIdOf = async (code) =>
  (await owner.query('SELECT id FROM users WHERE wechat_subject_lookup=decode($1,\'hex\')', [subject(code)])).rows[0].id;
const countExports = async (userId) =>
  Number((await owner.query('SELECT count(*)::int n FROM exports WHERE user_id=$1', [userId])).rows[0].n);
const exportRowFor = async (userId) =>
  (await owner.query('SELECT * FROM exports WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [userId])).rows[0] ?? null;
const writebackCount = async (exportId) =>
  Number((await owner.query('SELECT count(*)::int n FROM export_writebacks WHERE export_id=$1', [exportId])).rows[0].n);

/** 合成 real 传输（**测试内**；不联网）：可切换 hang/正常，用于观察在途竞态。 */
function syntheticRecognitionProvider() {
  let mode = 'normal';
  const calls = [];
  let releaseHang = null;
  return {
    provider: {
      executionMode: 'real',
      modelVersion: 'synthetic-test-transport-v1',
      note: '测试内合成 real 传输（不联网、不调用任何第三方）；仅用于驱动账本派发竞态',
      available: true,
      unavailableReason: null,
      async recognize(input) {
        calls.push(input);
        if (mode === 'hang') {
          return new Promise((resolve) => {
            releaseHang = () =>
              resolve({
                kind: 'completed',
                candidates: [
                  { species_id: 'synthetic_weed_a', rank: 1, model_score: 0.91 },
                  { species_id: 'synthetic_weed_b', rank: 2, model_score: 0.4 },
                ],
              });
          });
        }
        return {
          kind: 'completed',
          candidates: [
            { species_id: 'synthetic_weed_a', rank: 1, model_score: 0.91 },
            { species_id: 'synthetic_weed_b', rank: 2, model_score: 0.4 },
          ],
        };
      },
    },
    calls,
    hang() {
      mode = 'hang';
    },
    normal() {
      mode = 'normal';
    },
    release() {
      const resolve = releaseHang;
      releaseHang = null;
      mode = 'normal';
      resolve?.();
    },
    pending() {
      return releaseHang !== null;
    },
  };
}

const runtimeUrl = new URL(url.href);
runtimeUrl.username = loginName;
runtimeUrl.password = password;

function makeHttp(origin) {
  return async (path, options = {}) => {
    const res = await fetch(`${origin}/api/v1${path}`, {
      ...options,
      headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.headers ?? {}) },
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body, text, headers: res.headers };
  };
}
const json = (token, options = {}) => ({
  ...options,
  ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  headers: {
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(options.headers ?? {}),
    token,
  },
});

let origin;
let http;
async function login(code) {
  const res = await http('/auth/wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `login-${code}` },
    body: JSON.stringify({ code }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { token: res.body.data.access_token, id: await userIdOf(code) };
}
async function grant(token, purpose) {
  const res = await http('/me/consents', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `grant-${purpose}-${randomUUID().slice(0, 8)}` },
    body: JSON.stringify({ purpose, policy_version: 'fixture-v1', recipient_ids: ['fixture-weed'] }),
    token,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}
async function grantForRecognition(token) {
  await grant(token, 'media_processing');
  return grant(token, 'external_inference');
}
async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
async function postRecognition(token, mediaId) {
  return http('/recognitions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `rec-${randomUUID().slice(0, 12)}` },
    body: JSON.stringify({ media_id: mediaId, media_revision: 1 }),
    token,
  });
}
async function terminalJobState(token, jobId) {
  const res = await http(`/jobs/${jobId}`, { token });
  if (res.status !== 200) return null;
  const state = res.body.data.state;
  return ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'].includes(state) ? state : null;
}

try {
  // ---------------------------------------------------------------- 1. 迁移与回滚
  const version = (await owner.query('SHOW server_version')).rows[0].server_version;
  assert.match(version, /^17\.11(?:\D|$)/);
  console.log(`Native PostgreSQL: ${version} @ ${url.hostname}:${url.port}${url.pathname}`);
  assert.equal((await owner.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
  assert.equal(
    (await owner.query('SELECT count(*)::int n FROM pg_roles WHERE rolname=ANY($1)', [[...groups, loginName]])).rows[0].n,
    0,
  );
  for (const name of ['0001_initial_schema.sql', '0003_privacy_consent.sql', '0008_auth_session.sql', '0009_consent_policy.sql', '0011_export_ledger.sql']) {
    await owner.query(sqlFile(`migrations/${name}`));
  }
  await owner.query(sqlFile('migrations/rollback/0011_export_ledger.down.sql'));
  assert.equal((await owner.query("SELECT to_regclass('export_writebacks') x")).rows[0].x, null);
  assert.equal(
    (await owner.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='exports' AND column_name='cancelled_at'")).rows[0].n,
    0,
  );
  await owner.query(sqlFile('migrations/0011_export_ledger.sql'));
  say('fresh native PG17.11：0001/0003/0008/0009/0011 up，0011 down 后表与列如实消失，再 up 成功');

  // ---------------------------------------------------------------- 2. 最小权限角色
  for (const file of ['roles/auth_privacy.sql', 'roles/consent_granter.sql', 'roles/egress_ledger.sql']) {
    await owner.query(sqlFile(file));
  }
  createdRoles.push(...groups);
  await owner.query(
    `CREATE ROLE ${loginName} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
  );
  createdRoles.push(loginName);
  await owner.query(`GRANT ${groups.join(',')} TO ${loginName}`);
  pool = createPool(runtimeUrl.href);
  const flags = (await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.ok(Object.values(flags).every((value) => value === false));
  say('运行时 LOGIN 继承 auth_privacy + consent_granter + egress_ledger，且无任何超级权限');

  const forbidden = [
    'UPDATE recipients SET deletion_verified=true',
    'UPDATE recipients SET enabled=false',
    "DELETE FROM exports WHERE state='failed'",
    'UPDATE exports SET consent_epoch=1',
    'UPDATE exports SET recipient_id=recipient_id',
    "UPDATE users SET state='deleted'",
    'ALTER TABLE exports ADD COLUMN forbidden int',
    'CREATE TABLE forbidden(x int)',
    'SELECT object_ref_cipher FROM media',
  ];
  for (const sql of forbidden) {
    await assert.rejects(pool.query(sql), (error) => error.code === '42501', `必须被权限拒绝：${sql}`);
  }
  await pool.query('SELECT id,state,auth_epoch FROM users LIMIT 1');
  await pool.query('SELECT * FROM exports LIMIT 1');
  await pool.query('SELECT * FROM export_writebacks LIMIT 1');
  say('egress_ledger 组：可读账本/回写与核验所需列；不可删账本行、不可改冻结快照列、不可写 recipients/users.state、无 DDL');

  // ---------------------------------------------------------------- 3. 合成政策/接收方/复审人
  const reviewer = (
    await owner.query("INSERT INTO admin_accounts(login_name,credential_hash) VALUES('fixture-reviewer','synthetic-unused') RETURNING id")
  ).rows[0].id;
  const bindings = {
    'fixture-weed': {
      config_version: 'fixture-config-v1',
      policy_version: 'fixture-recipient-v1',
      capability: 'weed',
      retention_online_days: 0,
      retention_backup_days: 0,
      no_training_evidence_ref: 'fixture://proof/no-training',
      deletion_evidence_ref: 'fixture://proof/deletion',
    },
  };
  for (const purpose of ['media_processing', 'external_inference']) {
    await owner.query(
      `INSERT INTO consent_policies(purpose,policy_version,source_kind,source_ref,content_sha256,review_evidence_ref,recipient_bindings,valid_from,valid_until,reviewed_by,reviewed_at,enabled)
       VALUES($1,'fixture-v1','synthetic','fixture://policy/terms',$2,'fixture://policy/review',$3::jsonb,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour',$4,clock_timestamp(),true)`,
      [purpose, 'a'.repeat(64), JSON.stringify(bindings), reviewer],
    );
  }
  await owner.query(
    `INSERT INTO recipients(id,display_name,capability,policy_version,retention_online_days,retention_backup_days,no_training_verified,deletion_verified,enabled,config_version)
     VALUES('fixture-weed','合成识别接收方（测试）','weed','fixture-recipient-v1',0,0,true,true,true,'fixture-config-v1')`,
  );
  say('合成用途政策 + 已验证接收方（fixture-weed, capability=weed, 禁止训练/可删除）就绪');

  // ---------------------------------------------------------------- 4. 装配（real + 合成 real 传输）
  const realConfig = { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'real', sessionSigningKey: key };
  const wechat = { exchange: async (code) => ({ subjectLookupHex: subject(code) }) };
  const synthetic = syntheticRecognitionProvider();
  // 媒体引用端口用**合成替身**：本脚本测的是外发账本/在途守卫，不测对象存储（真实存储未接线）。
  const mediaPort = createSubstituteMediaPort();
  app = buildApp({
    config: realConfig,
    pool,
    wechat,
    recognitionProvider: synthetic.provider,
    recognitionMedia: mediaPort,
    consentGrantTestOptions: { allowSyntheticGrantPolicy: true },
  });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  http = makeHttp(origin);
  say('buildApp(real + 真 PG 池 + 注入的合成 real 传输) 启动（后台域 real 仍 fail-closed，与本片无关）');

  // ---------------------------------------------------------------- 5. 实际派发
  const a = await login('ledger-a');
  await grantForRecognition(a.token);
  const mediaA = randomUUID();
  const createdA = await postRecognition(a.token, mediaA);
  assert.equal(createdA.status, 202, JSON.stringify(createdA.body));
  const jobA = createdA.body.data.id;
  const stateA = await waitFor(() => terminalJobState(a.token, jobA), 'A 任务终态');
  assert.equal(stateA, 'succeeded');
  const rowA = await exportRowFor(a.id);
  assert.equal(rowA.state, 'sent');
  assert.equal(rowA.purpose, 'external_inference');
  assert.equal(rowA.recipient_id, 'fixture-weed');
  assert.equal(rowA.job_id, jobA);
  assert.equal(Number(rowA.auth_epoch), 1);
  assert.deepEqual(Object.keys(rowA.required_consents).sort(), ['external_inference', 'media_processing']);
  const writtenA = await owner.query('SELECT * FROM export_writebacks WHERE export_id=$1', [rowA.id]);
  assert.equal(writtenA.rows.length, 1);
  assert.equal(writtenA.rows[0].result.content_class, 'structural_only');
  assert.equal(JSON.stringify(writtenA.rows[0].result).includes('synthetic_weed_a'), false, '回写不得落提供者载荷');
  assert.equal((await http(`/recognitions/${createdA.body.data.target_ref.id}`, { token: a.token })).status, 200);
  say('实际派发（真 PG）：reserve→assertExecutable→markSent→传输→saveResult；账本如实登记 userid/purpose/recipient/job，回写仅结构分类');

  // ---------------------------------------------------------------- 6. 重复派发被拒
  const ledger = createPostgresExportLedger({ pool });
  await assert.rejects(
    () => ledger.markSent(rowA.id),
    (error) => error.code === 'OBJECT_UNAVAILABLE' && /非预留态/.test(error.message),
  );
  assert.equal((await owner.query('SELECT count(*)::int n FROM exports WHERE user_id=$1', [a.id])).rows[0].n, 1);
  say('重复派发被拒：已 sent 的预留行再次 markSent ⇒ OBJECT_UNAVAILABLE（零重复外发、不新增行）');

  // ---------------------------------------------------------------- 7. HTTP 撤回端到端 + 晚到零写入
  const b = await login('ledger-b');
  const grantB = await grantForRecognition(b.token);
  synthetic.hang();
  const mediaB = randomUUID();
  const createdB = await postRecognition(b.token, mediaB);
  assert.equal(createdB.status, 202, JSON.stringify(createdB.body));
  const sentB = await waitFor(async () => {
    const row = await exportRowFor(b.id);
    return row?.state === 'sent' ? row : null;
  }, 'B 外发已 markSent（在途）');
  const withdrawn = await http('/me/consents/external_inference', {
    method: 'DELETE',
    headers: { 'if-match': `"${grantB.revision}"`, 'idempotency-key': `wd-${randomUUID().slice(0, 12)}` },
    token: b.token,
  });
  assert.equal(withdrawn.status, 200, `撤回必须成功（消费者已接线，而不是 409 兜底）：${JSON.stringify(withdrawn.body)}`);
  const afterWithdraw = await exportRowFor(b.id);
  assert.equal(afterWithdraw.state, 'failed', '撤回必须撤销在途外发');
  assert.equal(afterWithdraw.error_code, 'CONSENT_WITHDRAWN');
  synthetic.release();
  await waitFor(() => terminalJobState(b.token, createdB.body.data.id), 'B 任务终态');
  assert.equal(await writebackCount(sentB.id), 0, '撤回后晚到的提供者结果必须零写入');
  const entryAfterWithdraw = await postRecognition(b.token, randomUUID());
  assert.equal(entryAfterWithdraw.status, 403, JSON.stringify(entryAfterWithdraw.body));
  assert.equal(entryAfterWithdraw.body.error.code, 'CONSENT_REQUIRED');
  assert.equal(await countExports(b.id), 1, '被拒的入口不得新增账本行');
  say('HTTP 撤回端到端（真 PG）：撤回 200 + 在途外发置 failed + 晚到结果零写入 + 入口拒绝且不新增账本行');

  // ---------------------------------------------------------------- 8. 取消墓碑不可复活
  const c = await login('ledger-c');
  await grantForRecognition(c.token);
  synthetic.hang();
  const mediaC = randomUUID();
  const createdC = await postRecognition(c.token, mediaC);
  assert.equal(createdC.status, 202, JSON.stringify(createdC.body));
  const jobC = createdC.body.data.id;
  const sentC = await waitFor(async () => {
    const row = await exportRowFor(c.id);
    return row?.state === 'sent' && row.job_id === jobC ? row : null;
  }, 'C 外发已 markSent（在途）');
  const jobRead = await http(`/jobs/${jobC}`, { token: c.token });
  const cancelledC = await http(`/jobs/${jobC}/cancel`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': jobRead.headers.get('etag'),
      'idempotency-key': `cancel-${randomUUID().slice(0, 12)}`,
    },
    body: JSON.stringify({ reason: '合成取消' }),
    token: c.token,
  });
  assert.equal(cancelledC.status, 200, JSON.stringify(cancelledC.body));
  const tombstone = await owner.query('SELECT state,cancelled_at,cancellation_reason FROM exports WHERE id=$1', [sentC.id]);
  assert.notEqual(tombstone.rows[0].cancelled_at, null, '取消必须写墓碑');
  assert.equal(tombstone.rows[0].state, 'failed');
  synthetic.release();
  await waitFor(() => terminalJobState(c.token, jobC), 'C 任务终态');
  assert.equal(await writebackCount(sentC.id), 0, '取消后晚到的提供者结果必须零写入');
  const revive = await postRecognition(c.token, mediaC);
  assert.equal(revive.status, 409, `同对象同版本不得再次预留（不可复活）：${JSON.stringify(revive.body)}`);
  assert.equal(revive.body.error.code, 'OBJECT_UNAVAILABLE');
  say('取消墓碑（真 PG）：/jobs/{id}/cancel 写只增不减墓碑 + 晚到零写入 + 同对象同版本再次预留被拒（不可复活）');

  // ---------------------------------------------------------------- 9. real 未接真实传输 ⇒ 零 sent
  realFallbackApp = buildApp({ config: realConfig, pool, wechat, consentGrantTestOptions: { allowSyntheticGrantPolicy: true } });
  const fallbackOrigin = await realFallbackApp.listen({ host: '127.0.0.1', port: 0 });
  const fallbackHttp = makeHttp(fallbackOrigin);
  const d = await login('ledger-d-real');
  for (const purpose of ['media_processing', 'external_inference']) {
    const grantedD = await fallbackHttp('/me/consents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `grant-d-${purpose}-${randomUUID().slice(0, 8)}` },
      body: JSON.stringify({ purpose, policy_version: 'fixture-v1', recipient_ids: ['fixture-weed'] }),
      token: d.token,
    });
    assert.equal(grantedD.status, 201, JSON.stringify(grantedD.body));
  }
  const deniedD = await fallbackHttp('/recognitions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `rec-d-${randomUUID().slice(0, 12)}` },
    body: JSON.stringify({ media_id: randomUUID(), media_revision: 1 }),
    token: d.token,
  });
  assert.equal(deniedD.status, 503, JSON.stringify(deniedD.body));
  assert.equal(deniedD.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(deniedD.body.error.retryable, true);
  assert.equal(await countExports(d.id), 0, 'real 未接真实传输：不得产生任何账本行（零 sent）');
  say('real 未接真实传输 ⇒ 受理处 503 PROVIDER_UNAVAILABLE(retryable)，且该用户**零 sent 记录**（在任何账本变更之前拒绝）');

  // ---------------------------------------------------------------- 10. 注销/停用 ⇒ 撤销在途
  const e = await login('ledger-e-deletion');
  await grantForRecognition(e.token);
  synthetic.hang();
  const createdE = await postRecognition(e.token, randomUUID());
  assert.equal(createdE.status, 202, JSON.stringify(createdE.body));
  const sentE = await waitFor(async () => {
    const row = await exportRowFor(e.id);
    return row?.state === 'sent' ? row : null;
  }, 'E 外发已 markSent（在途）');
  // 契约口径（state-contract §105）：注销受理在同一提交里置 deletion_pending 并递增 auth_epoch。
  await owner.query("UPDATE users SET state='deletion_pending', auth_epoch=auth_epoch+1 WHERE id=$1", [e.id]);
  const afterDeletion = await postRecognition(e.token, randomUUID());
  assert.equal(afterDeletion.status, 403, JSON.stringify(afterDeletion.body));
  assert.equal(afterDeletion.body.error.code, 'ACCOUNT_INACTIVE');
  const privacyPorts = createPostgresPrivacyPorts({ pool });
  const revoker = createEgressRevoker({ ledger });
  const inFlight = createInFlightGuard({ ledger, account: privacyPorts.account, consentStore: privacyPorts.consentStore });
  assert.equal((await revoker.onAccountSuspendedOrDeleted({ userId: e.id })).revokedInFlight, 1);
  assert.equal((await owner.query('SELECT state FROM exports WHERE id=$1', [sentE.id])).rows[0].state, 'failed');
  synthetic.release();
  // 账号已非活跃 ⇒ 经 HTTP 读该作业本身已被守卫拒绝（旧会话失效），因此只等处理器跑完并对**库**断言。
  const jobAfterDeletion = await http(`/jobs/${createdE.body.data.id}`, { token: e.token });
  assert.ok([401, 403].includes(jobAfterDeletion.status), `注销后不得再读到作业：${jobAfterDeletion.status}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await writebackCount(sentE.id), 0, '注销后在途回写必须零写入');
  await assert.rejects(
    () => inFlight.assertExecutable({ exportId: sentE.id, userId: e.id }),
    (error) => ['ACCOUNT_INACTIVE', 'OBJECT_UNAVAILABLE'].includes(error.code),
  );
  say('注销/停用（真 PG，契约口径模拟）：入口 403 ACCOUNT_INACTIVE + 在途撤销 + 晚到结果零写入（HTTP 触发面 requestAccountDeletion 仍为 planned）');

  console.log(`\nRESULT=PASS ${passed} 组；真实 PostgreSQL ${version}（本机隔离、仅回环）；未发出任何对外/付费请求`);
} finally {
  await app?.close?.();
  await realFallbackApp?.close?.();
  await pool?.end?.();
  for (const role of createdRoles.reverse()) {
    await owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`).catch(() => {});
    await owner.query(`DROP OWNED BY ${role}`).catch(() => {});
    await owner.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  }
  await owner.query('DROP TABLE IF EXISTS export_writebacks').catch(() => {});
  await owner.end();
  console.log('CLEANUP=done（角色与回写表已清理；库由运行器删除）');
}
