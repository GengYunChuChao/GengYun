// #1145 可观测性缺口：媒体外发**成功路径**必须在应用日志里留下行。
//
// 缺口原状（Sek1ro-oka 实测）：真实外发跑通后应用日志 116 行全是请求日志，`err` 为空，
// 证据只在 `public.provider_call_ledger` 表 —— 因为生产装配（`app.ts` 的 `mediaEgress`）
// 只给记账层传了「异常出口」，`createMediaJobEgress` 本身**没有日志钩子**。
//
// 本文件钉住三件事：
//   1. `real` 的成功路径真的发出 `egress_reserved` / `egress_sent` / `egress_saved`，
//      且每行**只有**约定的键（⛔ 对象内容、URL、prompt、模型输出、坐标、用户文本一律不许出现）；
//   2. 未登记即派发 ⇒ `egress_failed` + `errorCode:'OBJECT_UNAVAILABLE'`，且**没有** `egress_sent`；
//      同时说明：`provider_call_ledger_unresolved` 那条记账告警里出现 `media_id` 是既有口径，
//      与本文件禁止的「对象内容/URL」不是同一件事；
//   3. 非 `real`（`stub`）**零** `egress_*` 行 —— 替身不外发、不记账，也不打点。
//
// 建 app 与抓 `logStream` 的手法沿用 `privacy-log-payload-redaction.test.mjs`：
// `buildApp({ logStream })` + `app.inject()` + 扫**这次运行产生的全部日志**。
// 外发账本/在途守卫不是内存替身：这里用 PGlite 真跑 `0001/0003/0008/0011/0014/0015`
// 迁移，让 `createPostgresExportLedger` + `createInFlightGuard` 真的读写 `public.exports`
// —— 否则「生产装配到底有没有把 log 接上」这条就测不到（内存替身会绕过装配）。
// 零网络、零真实凭据；微信身份是显式注入的合成 exchange。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createGuardConsentGate } from '../../services/api/src/privacy/egress.ts';
import { createMediaJobEgress } from '../../services/api/src/privacy/task-egress.ts';
import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { createPrivacyGuard } from '../../packages/privacy/guard.mjs';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createStubRecognitionProvider } from '../../services/api/src/recognitions/provider.ts';
import { createSubstituteMediaPort } from '../../services/api/src/recognitions/media.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createAccountProvider } from '../privacy/_fixtures.mjs';

const API = '/api/v1';
// 冻结时钟只为让会话「未过期」且可复现，**不能**写成固定的过去日期：
// `sessions.created_at` 取库内真实时钟（DEFAULT now()），而 `expires_at` 用这里的
// 冻结时钟 + TTL（USER_SESSION_TTL_SECONDS=7d）推出；一旦真实时间越过「START + 7 天」，
// 就会 `expires_at < created_at`，违反 `sessions_expires_after_creation`（issue #1225：
// 2026-11-14 起 unit-tests 因此必红）。故把冻结时钟锚在「真实 now 往前一分钟」，
// 既让过期窗口保持在未来，又不依赖具体日期。
const START = Date.now() - 60_000;
const MEDIA_ID = '11111111-1111-4111-8111-111111111111';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 只用来证明「提供者回包里的私有内容不会被日志顺手带出来」的合成哨兵。
// 识别服务只消费 candidates/uncertainty_reasons，额外字段会被丢弃；若哪天有人把整份
// 回包塞进日志，这个串会出现，本文件立刻变红。
const PRIVATE_MARKER = '私有回包哨兵-ZZ-7f3a';
const PRIVATE_SPECIES = 'sentinel_private_species';

// 与真实装配同形的**已验证接收方**（能力必须是识别链路的 `weed`）。
const RECIPIENT = {
  id: 'provider-weed-egress-log-test',
  display_name: 'Weed Provider (synthetic)',
  capability: 'weed',
  policy_version: '1.0.0',
  retention_online_days: 7,
  retention_backup_days: 30,
  no_training_verified: true,
  deletion_verified: true,
  enabled: true,
  config_version: '1.0.0',
};

// 媒体三面共用的必需用途（识别实际要求 media_processing + external_inference；
// recording 一并授予，与 `privacy-log-payload-redaction.test.mjs` 的夹具同口径）。
const PURPOSES = ['recording', 'media_processing', 'external_inference'];

// 生产装配真实模式所需的最小合成环境（与 `privacy-egress-http.test.mjs` 的 REAL_ENV 同形）。
const REAL_ENV = {
  APP_EXECUTION_MODE: 'real',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
  SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
  DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
  WECHAT_APP_ID: 'synthetic-not-a-real-appid',
  WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
  OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
};

// 只取与「外发账本 + 在途守卫 + 登录」直接相关的迁移：
// 0001 users/sessions、0003 recipients/privacy_epochs/consent_records/exports、
// 0008 idempotency_keys（登录与受理幂等）、0011 exports 新列 + export_writebacks、
// 0014/0015 object_key（媒体行 object_key 为 NULL，但真账本 INSERT 会写这一列）。
const MIGRATION_SQL = [
  '0001_initial_schema',
  '0003_privacy_consent',
  '0008_auth_session',
  '0011_export_ledger',
  '0014_export_object_key',
  '0015_export_object_key_shape',
].map((name) => readFileSync(new URL(`../../services/api/db/migrations/${name}.sql`, import.meta.url), 'utf8'));

function memoryLog() {
  const chunks = [];
  return {
    chunks,
    stream: { write(chunk) { chunks.push(chunk); } },
    text() { return chunks.join(''); },
  };
}

/** pino 自带字段；「行里只有允许的键」判据只针对业务字段。 */
const PINO_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'msg']);

function businessPayload(record) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !PINO_KEYS.has(key)));
}

/** 把这次运行的日志流拆成 JSON 记录；非 JSON 行直接判红（抓取手法本身不能是坏的）。 */
function logRecords(log) {
  const records = [];
  for (const line of log.text().split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      assert.fail(`日志行不是 JSON：${line.slice(0, 200)}`);
    }
  }
  return records;
}

/** 所有 `egress_*` 业务事件（只看 `event` 字段，不看 msg/url）。 */
function egressEvents(records) {
  return records.filter((record) => typeof record.event === 'string' && record.event.startsWith('egress_'));
}

function assertOnlyKeys(record, allowed, label) {
  assert.deepEqual(Object.keys(businessPayload(record)).sort(), [...allowed].sort(), `${label} 的键集不符`);
}

/**
 * 起一个真装配 app：
 * - PGlite 真账本（`pool.connect()` / `pool.query()` 形状与生产 `PgPool` 一致）；
 * - 登录走 PG 会话存储（`real` 模式不接受内存会话）；
 * - `privacyInjection.consent` 用内存授权门（与本文件的 PG 授权种子同值），
 *   这样 HTTP 面走通，而外发预留/派发/回写仍由**真** PG 账本与在途守卫判定；
 * - 历史域固定注入内存 store（本文件不测历史，避免为它多跑迁移）。
 */
async function makeFixture(t, { executionMode = 'real', deleteReservationBeforeDispatch = false } = {}) {
  const db = new PGlite();
  for (const sql of MIGRATION_SQL) await db.exec(sql);
  const run = async (text, params) => {
    const result = await db.query(text, params);
    // PGlite 用 `affectedRows`；`ledger-pg.ts` 的 ON CONFLICT 分支读 `rowCount`。
    return { ...result, rowCount: result.affectedRows };
  };
  const pool = { query: run, connect: async () => ({ query: run, release() {} }) };

  const log = memoryLog();
  const authStore = createPostgresAuthStore(pool);
  const consentStore = createConsentStore();
  const account = createAccountProvider();

  const substituteMedia = createSubstituteMediaPort();
  // 「未登记即派发」的合成方式：受理时的预留已经写成（日志里会有 egress_reserved），
  // 在媒体引用解析这一步把预留删掉，模拟「派发时预留已不存在」（撤回/过期/他处清理）。
  const recognitionMedia = deleteReservationBeforeDispatch
    ? {
        ...substituteMedia,
        async resolve(input) {
          const resolution = await substituteMedia.resolve(input);
          await run('DELETE FROM public.exports');
          return resolution;
        },
      }
    : substituteMedia;

  const stub = createStubRecognitionProvider();
  // 成功路径的替身提供者：回包里塞一个私有哨兵，用来证明日志没有顺手带出对象内容。
  const recognitionProvider = {
    ...stub,
    async recognize(input) {
      const outcome = await stub.recognize(input);
      return {
        ...outcome,
        private_marker: PRIVATE_MARKER,
        ...(outcome.kind === 'completed'
          ? {
              candidates: outcome.candidates.map((candidate, index) => (
                index === 0 ? { ...candidate, species_id: PRIVATE_SPECIES } : candidate
              )),
            }
          : {}),
      };
    },
  };

  const config = loadConfig(
    executionMode === 'real'
      ? REAL_ENV
      : { APP_EXECUTION_MODE: executionMode, LOG_LEVEL: 'info', SESSION_SIGNING_KEY: 'synthetic-egress-log-signing-key-0123456789' },
  );
  const app = buildApp({
    config,
    pool,
    store: authStore,
    now: () => new Date(START),
    logStream: log.stream,
    wechat: {
      async exchange() {
        return { subjectLookupHex: createHash('sha256').update('synthetic-egress-log-user').digest('hex') };
      },
    },
    privacyInjection: {
      consent: createGuardConsentGate(createPrivacyGuard({ account, consentStore })),
    },
    recognitionStore: createMemoryRecognitionStore(),
    recognitionProvider,
    recognitionMedia,
    historyInjection: { store: createMemoryHistoryStore() },
  });
  t.after(async () => {
    await app.close();
    await db.close();
  });

  const login = await app.inject({
    method: 'POST',
    url: `${API}/auth/wechat`,
    headers: { 'content-type': 'application/json', 'idempotency-key': 'egress-log-login-key-0001' },
    payload: { code: 'synthetic-egress-log' },
  });
  assert.equal(login.statusCode, 200, login.body);
  const token = login.json().data.access_token;
  const session = await authStore.findSession(hashToken(token), 'user');
  assert.ok(session !== null && session !== undefined, '前置：合成登录必须留下会话');
  const userId = session.userId;

  // 授权事实的**唯一真源**是 PG（账本预留/派发/回写都在同一个事务里重读）；
  // 内存 consentStore 只服务 HTTP 面的授权中间件，两处给同一组值。
  await run(
    `INSERT INTO public.recipients(id,display_name,capability,policy_version,retention_online_days,
       retention_backup_days,no_training_verified,deletion_verified,enabled,config_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      RECIPIENT.id, RECIPIENT.display_name, RECIPIENT.capability, RECIPIENT.policy_version,
      RECIPIENT.retention_online_days, RECIPIENT.retention_backup_days,
      RECIPIENT.no_training_verified, RECIPIENT.deletion_verified, RECIPIENT.enabled,
      RECIPIENT.config_version,
    ],
  );
  for (const purpose of PURPOSES) {
    await run(
      `INSERT INTO public.consent_records(user_id,purpose,policy_version,recipient_ids,state,epoch)
       VALUES($1::uuid,$2::consent_purpose,$3,$4::jsonb,'granted',1)`,
      [userId, purpose, '1.0.0', JSON.stringify([RECIPIENT.id])],
    );
    await run(
      `INSERT INTO public.privacy_epochs(user_id,purpose,current_epoch,state)
       VALUES($1::uuid,$2::consent_purpose,1,'granted')`,
      [userId, purpose],
    );
    await consentStore.grant({
      userId,
      purpose,
      policyVersion: '1.0.0',
      recipientIds: [RECIPIENT.id],
    });
  }

  return { app, log, token, db };
}

async function acceptRecognition(app, token) {
  return app.inject({
    method: 'POST',
    url: `${API}/recognitions`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': 'egress-log-recognition-0001',
    },
    payload: { media_id: MEDIA_ID, media_revision: 1 },
  });
}

// ---------------------------------------------------------------------------
// 一、成功路径：reserved → sent → saved，三行都在，且键集严格受限
// ---------------------------------------------------------------------------

test('媒体外发成功路径：日志出现 egress_sent / egress_saved，且每行只有约定键', async (t) => {
  const { app, log, token } = await makeFixture(t);
  const response = await acceptRecognition(app, token);
  assert.equal(response.statusCode, 202, `受理应 202：${response.body}`);
  const jobId = response.json().data.id;
  assert.match(jobId, UUID, '前置：作业 id 必须是 uuid');
  await app.recognitionService.settle();

  const records = logRecords(log);
  assert.ok(records.length > 0, '日志流为空：抓取手法或 pino 配置有问题');
  const egress = egressEvents(records);
  assert.ok(egress.length > 0, '没有任何 egress_* 行：生产装配的 log 钩子没接上');

  const reserved = egress.filter((record) => record.event === 'egress_reserved');
  const sent = egress.filter((record) => record.event === 'egress_sent');
  const saved = egress.filter((record) => record.event === 'egress_saved');
  assert.equal(reserved.length, 1, '成功路径应有且仅有一次预留');
  assert.equal(sent.length, 1, '成功路径应有且仅有一次派发');
  assert.equal(saved.length, 1, '成功路径应有且仅有一次保存');
  assert.equal(egress.some((record) => record.event === 'egress_failed'), false, '成功路径不许发失败事件');
  assert.equal(egress.some((record) => record.event === 'egress_refused'), false, '成功路径不许发拒绝事件');

  for (const record of [reserved[0], sent[0], saved[0]]) {
    assert.equal(record.dataType, 'weed_recognition');
    assert.equal(record.purpose, 'external_inference');
    assert.equal(record.capability, 'weed');
    assert.match(record.exportId, UUID);
  }
  // 三行指向同一次外发。
  assert.equal(reserved[0].exportId, sent[0].exportId);
  assert.equal(sent[0].exportId, saved[0].exportId);
  // `jobId` 只在传入字符串时出现，且就是本次作业 id。
  assert.equal(sent[0].jobId, jobId);

  assertOnlyKeys(reserved[0], ['event', 'dataType', 'purpose', 'capability', 'exportId'], 'egress_reserved');
  assertOnlyKeys(sent[0], ['event', 'dataType', 'purpose', 'capability', 'exportId', 'jobId'], 'egress_sent');
  assertOnlyKeys(saved[0], ['event', 'dataType', 'purpose', 'capability', 'exportId'], 'egress_saved');

  // ⛔ 日志全文不得出现对象内容/URL（media_id 是对象标识，既有记账告警里可能出现，不在本禁项）。
  const text = log.text();
  assert.ok(text.length > 0);
  assert.equal(text.includes(PRIVATE_MARKER), false, '日志泄漏了提供者回包里的私有内容');
  assert.equal(text.includes(PRIVATE_SPECIES), false, '日志泄漏了识别候选（模型输出）');
  assert.equal(text.includes('data:'), false, '日志出现 data: URI');
  assert.equal(text.includes(REAL_ENV.OBJECT_STORAGE_ENDPOINT), false, '日志出现对象存储 URL');
});

// ---------------------------------------------------------------------------
// 二、未登记即派发：egress_failed + OBJECT_UNAVAILABLE，且没有 egress_sent
// ---------------------------------------------------------------------------

test('未登记即派发：日志出现 egress_failed(OBJECT_UNAVAILABLE)，且没有 egress_sent', async (t) => {
  const { app, log, token } = await makeFixture(t, { deleteReservationBeforeDispatch: true });
  const response = await acceptRecognition(app, token);
  assert.equal(response.statusCode, 202, `受理应 202：${response.body}`);
  await app.recognitionService.settle();

  const records = logRecords(log);
  assert.ok(records.length > 0, '日志流为空');
  const egress = egressEvents(records);
  assert.ok(egress.length > 0, '没有任何 egress_* 行（预留那行至少应在）');

  const sent = egress.filter((record) => record.event === 'egress_sent');
  assert.equal(sent.length, 0, '未登记就派发：绝不能出现 egress_sent（那会把零外发洗成已发）');

  const failed = egress.filter((record) => record.event === 'egress_failed');
  assert.equal(failed.length, 1, '未登记拒绝应恰好留下一条 egress_failed');
  assert.equal(failed[0].errorCode, 'OBJECT_UNAVAILABLE');
  assert.equal('exportId' in failed[0], false, '未登记拒绝没有 exportId，不得凭空补一个');
  assertOnlyKeys(failed[0], ['event', 'dataType', 'purpose', 'capability', 'errorCode'], 'egress_failed（未登记）');
});

// ---------------------------------------------------------------------------
// 三、非 real：零 egress_* 行（替身不外发 ⇒ 不记账，也不打点）
// ---------------------------------------------------------------------------

test('非 real（stub）：完全没有 egress_* 事件行（但请求日志照常）', async (t) => {
  const { app, log, token, db } = await makeFixture(t, { executionMode: 'stub' });
  const response = await acceptRecognition(app, token);
  assert.equal(response.statusCode, 202, `stub 受理应 202：${response.body}`);
  await app.recognitionService.settle();

  const records = logRecords(log);
  assert.ok(records.length > 0, '日志流为空：正向对照失败');
  assert.equal(
    egressEvents(records).length,
    0,
    `stub 模式出现了 egress_* 行：${JSON.stringify(egressEvents(records))}`,
  );
  // 下界：证明这次运行确实有日志（不是因为日志级别静默而「零 egress」）。
  assert.equal(log.text().includes('"msg":"incoming request"'), true, '正向对照失败：缺 incoming request');

  const rows = await db.query('SELECT count(*)::int AS c FROM public.exports');
  assert.equal(rows.rows[0].c, 0, 'stub 模式不预留、不记账：exports 必须零行');
});

// ---------------------------------------------------------------------------
// 四、正向对照：成功路径那次抓到的日志里确实有请求开始/完成（抓取手法自证）
// ---------------------------------------------------------------------------

test('正向对照：成功路径日志里仍有 incoming request / request completed（202）', async (t) => {
  const { app, log, token } = await makeFixture(t);
  const response = await acceptRecognition(app, token);
  assert.equal(response.statusCode, 202, response.body);
  await app.recognitionService.settle();

  const records = logRecords(log);
  assert.ok(records.length > 0, '日志流为空：抓取手法本身失效');

  // Fastify 默认 pino 序列化把请求放在 `req`、响应放在 `res`（不再是顶层 url/statusCode）。
  const incoming = records.filter(
    (record) => record.msg === 'incoming request'
      && record.req?.method === 'POST'
      && record.req?.url === `${API}/recognitions`,
  );
  const completed = records.filter(
    (record) => record.msg === 'request completed'
      && record.res?.statusCode === 202
      && incoming.some((started) => started.reqId === record.reqId),
  );
  assert.ok(incoming.length > 0, '缺 POST /recognitions 的 incoming request');
  assert.ok(completed.length > 0, '缺 POST /recognitions 的 request completed（202）');
});

// ---------------------------------------------------------------------------
// 五、fail-closed 拒绝分支：发 egress_refused；日志出口自己抛错不得改判主流程
// ---------------------------------------------------------------------------

test('real 未接真实传输：发 egress_refused；log 抛错不影响 fail-closed', async () => {
  const events = [];
  const egress = createMediaJobEgress({
    // provider() 从未被调用 ⇒ providerAvailable=false ⇒ 在任何账本变更之前拒绝，
    // 因此这个空账本对象一个方法都不会被碰到。
    ledger: {},
    inFlight: {},
    executionMode: 'real',
    dataType: 'weed_recognition',
    capability: 'weed',
    log: (event) => {
      events.push(event);
      throw new Error('synthetic log sink down');
    },
  });

  await assert.rejects(
    egress.reserveForAcceptance({
      userId: '00000000-0000-4000-8000-000000000001',
      authEpoch: 1,
      objectId: MEDIA_ID,
      objectRevision: 1,
    }),
    (error) => error?.code === 'PROVIDER_UNAVAILABLE',
    '日志出口抛错不得替换业务错误',
  );

  assert.equal(events.length, 1, '拒绝分支应恰好发一条事件');
  assert.equal(events[0].event, 'egress_refused');
  assert.equal(events[0].errorCode, 'PROVIDER_UNAVAILABLE');
  assert.deepEqual(
    Object.keys(events[0]).sort(),
    ['capability', 'dataType', 'errorCode', 'event', 'purpose'],
    'egress_refused 的键集不符',
  );
});
