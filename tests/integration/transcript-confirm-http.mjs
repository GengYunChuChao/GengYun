// GY-I11 客户端转写核对 · 隔离集成回归：**经真实装配的 app**（`buildApp`，stub 模式）
// + 本机 loopback 真实 HTTP + **未经修改的原生客户端模块**（`miniprogram/utils/speech-transcript.js`
// 经 vm 加载，`wx.request` 桥接到真实 fetch）。
//
// 运行：`node tests/integration/transcript-confirm-http.mjs`（退出码 0 表示通过）。
//
// 边界（如实标注，不得外推）：
// - 只用本机回环（127.0.0.1，随机端口）；**不发起任何外网请求**、**不连接任何数据库**（内存 store）；
// - 身份是**合成**的：经 `AuthStore` 公开 API 播种会话（同 `speech-http.mjs` 对 real 实例的口径；
//   登录路径本身由既有回归覆盖，本文件不重复声称）；
// - ASR 提供者是**明确标注的替身**（stub 分桶：normal / confident / silent）；**不是真实供应商**；
// - **ASR 真实样本为 0** ⇒ 本脚本不产生、不声称任何准确率或转写质量结论；
// - 服务端语义（占位幂等、同键回放、失败终态不写记录）由 `tests/integration/speech-http.mjs`
//   与 `tests/unit/speech-service.test.mjs` 锁定；本文件只补**客户端消费层**对真实装配的端到端形状：
//   确认幂等（同键回放不重复写入）、发送幂等（同键回放不建第二条轮次）、
//   **未确认/已删除不得外发**（服务端同样拒绝，纵深防御）、迟到/取消不产生任何外发。
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const requireHere = createRequire(import.meta.url);
const API = '/api/v1';
const observations = [];

let passed = 0;
async function group(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error?.message}`);
    throw error;
  }
}

/** 回环 HTTP 观察通道（只走 127.0.0.1；用于读取服务端状态佐证，不替代客户端模块）。 */
function makeHttp(origin) {
  return async function http(path, options = {}) {
    const headers = {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    };
    const response = await fetch(origin + path, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: response.status, body, etag: response.headers.get('etag'), cache: response.headers.get('cache-control') };
  };
}

/** 播种合成身份与会话（不经过微信换取，不产生任何外网调用）。 */
async function seedSession(authStore, label) {
  const user = await authStore.createUser(`${label}-${randomUUID().replace(/-/g, '')}`);
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });
  return { token, userId: user.id };
}

/** 与 `services/api/src/speech/provider.ts` 的 `bucketOf` 同口径：sha256(media_id) 首字节对 6 取模。 */
function mediaIdForBucket(bucket) {
  for (let attempt = 0; attempt < 500000; attempt += 1) {
    const candidate = randomUUID();
    if (createHash('sha256').update(candidate).digest()[0] % 6 === bucket) return candidate;
  }
  throw new Error(`未找到分桶 ${bucket} 的媒体 uuid`);
}

// ---------------------------------------------------------------- 真实装配（stub 模式）
const authStore = createMemoryAuthStore();
const app = buildApp({ config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), store: authStore });
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const http = makeHttp(origin);
const speech = app.speechService;
const providerCalls = () => speech.describe().providerCalls;
observations.push('loopback origin=' + origin);
observations.push('execution_mode=' + speech.describe().executionMode + ' provider=' + speech.describe().modelVersion);

// ---------------------------------------------------------------- 原生客户端模块（vm + fetch 桥）
const session = await seedSession(authStore, 'i11-transcript');
const wx = {
  request(o) {
    fetch(o.url, {
      method: o.method,
      headers: Object.assign({}, o.header || {}),
      ...(o.data === undefined ? {} : { body: JSON.stringify(o.data) }),
    })
      .then(async (response) => {
        const text = await response.text();
        let data = null;
        try { data = JSON.parse(text); } catch { data = null; }
        const header = {};
        const etag = response.headers.get('etag');
        if (etag !== null) header.ETag = etag;
        if (o.success) o.success({ statusCode: response.status, data, header });
      })
      .catch(() => { if (o.fail) o.fail({}); });
  },
};
const injectedAuth = {
  isLoggedIn: () => true,
  getSession: () => ({ accessToken: session.token }),
  sessionEpoch: () => 'epoch-seed',
  networkEnabled: () => true,
  clearSession: () => {},
};
const injectedRuntime = { mode: 'local', apiBaseUrl: origin + API };
const moduleCache = new Map();
function loadReal(file) {
  if (moduleCache.has(file)) return moduleCache.get(file);
  const box = { exports: {} };
  moduleCache.set(file, box.exports);
  const wrapper = vm.compileFunction(readFileSync(file, 'utf8'), ['module', 'exports', 'require', '__filename', '__dirname'], { filename: file });
  const resolveDep = (id) => {
    if (id === './auth') return injectedAuth;
    if (id === '../config/runtime') return injectedRuntime;
    throw new Error('unexpected require: ' + id);
  };
  wrapper(box, box.exports, resolveDep, file, dirname(file));
  moduleCache.set(file, box.exports);
  return box.exports;
}
const client = loadReal(join(ROOT, 'miniprogram/utils/speech-transcript.js'));
// 客户端模块在**调用期**读全局 `wx`（与真机一致）；这里把桥接对象装上，finally 卸载。
globalThis.wx = wx;

/** 轮询等待转写记录（404 是正常中间态；失败终态永不产生记录 ⇒ 由调用方按截止时间收口）。 */
async function waitForRecord(transcriptionId, attempts = 600) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await client.getTranscription(transcriptionId);
    } catch (error) {
      if (error.code !== 'NOT_FOUND') throw error;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  throw new Error('转写记录未在预期时间内产出');
}

try {
  const mediaNormal = mediaIdForBucket(0);
  const mediaConfident = mediaIdForBucket(1);
  const mediaSilent = mediaIdForBucket(2);

  // ---------------------------------------------------------------- [1] 确认 + 发送全链路
  await group('[1] 受理→轮询→可编辑确认→发送：客户端模块对真实装配的端到端形状', async () => {
    const created = await client.createTranscription({ media_id: mediaNormal, media_revision: 1 }, client.newKey('i11-create'));
    assert.equal(created.mode, 'stub', 'meta.execution_mode 必须是 stub');
    assert.ok(created.job.deadline_at.length > 0, '202 必须回传截止时间（轮询边界唯一来源）');
    const transcriptionId = created.transcriptionId;

    const read1 = await waitForRecord(transcriptionId);
    assert.equal(read1.record.revision, 1, '首读 revision 必须为 1');
    assert.equal(read1.record.confirmed_text, null, '未经用户确认时 confirmed_text 必须为 null');
    assert.match(read1.record.model_version, /stub/, '替身 model_version 必须带标注');
    assert.equal(read1.etag, '"1"', '读面必须回传强 ETag');
    assert.equal(read1.mode, 'stub');

    // 用户编辑后的正文（夹具：在原始转写上追加校对说明）。
    const confirmedText = read1.record.raw_text + '（用户已校对）';
    const confirmKey = client.newKey('i11-confirm');
    const confirmed = await client.confirmTranscription({
      transcriptionId, revision: read1.record.revision, confirmedText, idempotencyKey: confirmKey,
    });
    assert.equal(confirmed.record.revision, 2, '确认必须递增 revision');
    assert.equal(confirmed.record.confirmed_text, confirmedText, '确认的必须是用户编辑后的正文');
    assert.notEqual(confirmed.record.confirmed_at, null, '确认必须落 confirmed_at');
    assert.equal(confirmed.record.raw_text, read1.record.raw_text, 'raw_text 不得被确认改写');
    assert.equal(confirmed.etag, '"2"');

    // **确认幂等**：同一把键原样重放 ⇒ 回放首次结果，不重复写入（revision 不得再递增）。
    const replay = await client.confirmTranscription({
      transcriptionId, revision: read1.record.revision, confirmedText, idempotencyKey: confirmKey,
    });
    assert.equal(replay.record.revision, 2, '同键重放不得产生第二次写入');
    assert.equal(replay.record.confirmed_text, confirmedText);
    const afterReplay = await client.getTranscription(transcriptionId);
    assert.equal(afterReplay.record.revision, 2, '存储层 revision 必须仍为 2');

    // 发送：建会话 → 语音轮次（If-Match 绑会话 revision）。
    const conversation = await client.createConversation(client.newKey('i11-conversation'));
    assert.equal(conversation.conversation.revision, 1);
    const sendKey = client.newKey('i11-send');
    const sent = await client.sendSpeechTurn({
      conversationId: conversation.conversation.id,
      conversationRevision: conversation.conversation.revision,
      transcriptionId,
      transcriptionRevision: confirmed.record.revision,
      idempotencyKey: sendKey,
    });
    assert.equal(sent.job.kind, 'answer', '发送必须返回回答任务');
    assert.equal(sent.job.state, 'queued');
    assert.equal(sent.etag, '"1"');

    // **发送幂等**：同一把键原样重放 ⇒ 不建第二条轮次。
    await client.sendSpeechTurn({
      conversationId: conversation.conversation.id,
      conversationRevision: conversation.conversation.revision,
      transcriptionId,
      transcriptionRevision: confirmed.record.revision,
      idempotencyKey: sendKey,
    });
    const turns = await http(`${API}/conversations/${conversation.conversation.id}/turns`, { token: session.token });
    assert.equal(turns.status, 200, JSON.stringify(turns.body));
    assert.equal(turns.body.data.items.length, 1, '同键重放不得创建第二条轮次');
    const turn = turns.body.data.items[0];
    assert.equal(turn.input_text, confirmedText, '轮次正文必须是用户确认后的正文');
    assert.deepEqual(
      { type: turn.transcription_ref.type, id: turn.transcription_ref.id, revision: turn.transcription_ref.revision },
      { type: 'transcription', id: transcriptionId, revision: 2 },
      '轮次必须绑定转写引用与确认后 revision'
    );
    observations.push('[1] turns=' + turns.body.data.items.length + ' providerCalls=' + providerCalls());
  });

  // ---------------------------------------------------------------- [2] 未确认不得外发（服务端纵深）
  await group('[2] 未确认的转写不得外发：服务端同样拒绝（INPUT_UNCERTAIN），且不产生轮次', async () => {
    const created = await client.createTranscription({ media_id: mediaConfident, media_revision: 1 }, client.newKey('i11-create'));
    const transcriptionId = created.transcriptionId;
    const read1 = await waitForRecord(transcriptionId);
    assert.equal(read1.record.confirmed_text, null);

    const conversation = await client.createConversation(client.newKey('i11-conversation'));
    let refused = null;
    try {
      await client.sendSpeechTurn({
        conversationId: conversation.conversation.id,
        conversationRevision: conversation.conversation.revision,
        transcriptionId,
        transcriptionRevision: read1.record.revision,
        idempotencyKey: client.newKey('i11-send'),
      });
    } catch (error) {
      refused = error;
    }
    assert.ok(refused !== null, '未确认的转写必须被拒绝');
    assert.equal(refused.code, 'INPUT_UNCERTAIN', '未确认必须落 INPUT_UNCERTAIN（不冒充受理）');
    const turns = await http(`${API}/conversations/${conversation.conversation.id}/turns`, { token: session.token });
    assert.equal(turns.body.data.items.length, 0, '未确认不得产生任何轮次');
    observations.push('[2] refused=' + refused.code + ' turns=0');

    // **取消**：删除后同样不得外发（服务端对该记录 NOT_FOUND / 未确认）。
    const cancelKey = client.newKey('i11-cancel');
    const deleted = await client.deleteTranscription({ transcriptionId, revision: read1.record.revision, idempotencyKey: cancelKey });
    assert.deepEqual(deleted, { accepted: true, mode: 'stub', etag: null });
    let afterDelete = null;
    try {
      await client.getTranscription(transcriptionId);
    } catch (error) {
      afterDelete = error;
    }
    assert.equal(afterDelete.code, 'NOT_FOUND', '删除后读取必须 404（记录已不存在）');

    let refusedAfterCancel = null;
    try {
      await client.sendSpeechTurn({
        conversationId: conversation.conversation.id,
        conversationRevision: conversation.conversation.revision,
        transcriptionId,
        transcriptionRevision: read1.record.revision,
        idempotencyKey: client.newKey('i11-send'),
      });
    } catch (error) {
      refusedAfterCancel = error;
    }
    assert.ok(refusedAfterCancel !== null, '取消后同样不得外发');
    assert.ok(['NOT_FOUND', 'INPUT_UNCERTAIN'].includes(refusedAfterCancel.code), '取消后外发必须被拒（实际 ' + refusedAfterCancel.code + '）');
    const turnsAfter = await http(`${API}/conversations/${conversation.conversation.id}/turns`, { token: session.token });
    assert.equal(turnsAfter.body.data.items.length, 0, '取消后不得产生任何轮次');
    observations.push('[2] afterCancel refused=' + refusedAfterCancel.code + ' turns=0');
  });

  // ---------------------------------------------------------------- [3] 受理幂等（同键同体）
  await group('[3] 同一 Idempotency-Key 原样重放受理：同一任务、不重复调用提供者', async () => {
    const key = client.newKey('i11-create');
    const first = await client.createTranscription({ media_id: mediaNormal, media_revision: 1 }, key);
    const before = providerCalls();
    const second = await client.createTranscription({ media_id: mediaNormal, media_revision: 1 }, key);
    assert.equal(second.job.id, first.job.id, '同键重放必须是同一任务');
    assert.equal(providerCalls(), before, '同键重放不得重复调用提供者（不重复执行副作用）');
    observations.push('[3] sameJob=' + (second.job.id === first.job.id) + ' providerCalls=' + providerCalls());
  });

  // ---------------------------------------------------------------- [4] 失败终态不产生记录、不外发
  await group('[4] 空转写（静默桶）：uncertain 终态不产生记录；截止后仍零轮次', async () => {
    const conversationsBefore = await http(`${API}/conversations`, { token: session.token });
    const beforeCount = conversationsBefore.body.data.items.length;
    const created = await client.createTranscription({ media_id: mediaSilent, media_revision: 1 }, client.newKey('i11-create'));
    const transcriptionId = created.transcriptionId;
    await speech.settle();
    // 进程内佐证（与 HTTP 观察通道分离）：任务落 uncertain + INPUT_UNCERTAIN，绝不 succeeded。
    const job = await speech.getJob({ userId: session.userId, jobId: created.job.id });
    assert.equal(job.state, 'uncertain', '空转写必须落 uncertain');
    assert.equal(job.error_code, 'INPUT_UNCERTAIN');
    assert.equal(job.result, null, '失败终态不得带结果');
    // HTTP 面：记录不存在（404），且从未产生任何新会话/轮次。
    const missed = await http(`${API}/speech/transcriptions/${transcriptionId}`, { token: session.token });
    assert.equal(missed.status, 404, '失败终态不产生转写记录');
    assert.equal(missed.body.error.code, 'NOT_FOUND');
    const conversationsAfter = await http(`${API}/conversations`, { token: session.token });
    assert.equal(conversationsAfter.body.data.items.length, beforeCount, '失败终态不得产生任何新会话/轮次');
    observations.push('[4] job=' + job.state + '/' + job.error_code + ' record=404 conversations=' + beforeCount);
  });

  // ---------------------------------------------------------------- [5] 误差观察
  await group('[5] 观察：替身提供者调用计数与执行模式（不含任何真实供应商声称）', async () => {
    const described = speech.describe();
    assert.equal(described.executionMode, 'stub');
    assert.match(described.providerNote, /替身/);
    assert.ok(described.providerCalls >= 3, '三次成功受理各一次真实调用（计数点在最发起处）');
    observations.push('[5] providerCalls=' + described.providerCalls + ' storePersistent=' + described.storePersistent);
  });

  console.log('PASS ' + passed + ' groups; loopback only, stub substitute ASR, no database, no external network');
  for (const line of observations) console.log('OBS ' + line);
} catch (error) {
  console.error('FAIL ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
} finally {
  delete globalThis.wx;
  await app.close();
}
