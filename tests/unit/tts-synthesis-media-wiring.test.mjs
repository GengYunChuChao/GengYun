// GY-R68 —— 合成（TTS）产物端口 `synthesisMediaWiring` 的**生产入口装配漏项**修补（Refs #13）。
//
// 断点（本轮复核的代码事实）：
//   `tts/media.ts` 的 `createSynthesisMediaPort(executionMode, options)` 在 `real` 下只认两个**显式注入**项
//   （`@see` 其 JSDoc：批准能力 + `s3_compatible` 端口，无默认值、不从 env 折算）；`app.ts` 的装配行
//   `media: synthesisMedia ?? createSynthesisMediaPort(config.executionMode, synthesisMediaWiring)` 只**转发**、
//   不铸造（域内注释明写「装配层不得自行铸造，那等于自我批准」）；而生产入口 `server.ts` 从不传该选项
//   ⇒ 即使运维带上 `--approve-real-media-wiring`（媒体域据此铸造批准能力、构造出 S3 兼容端口），
//   合成产物端口在 `real` 下仍**恒为 `unwired`**，`POST /speech/synthesis` 恒拒。
//
// 本文件钉住三件事：
//   ① **装配后不再恒 unwired**：`server.ts` 的同一次批准判定里必须派生 `synthesisMediaWiring`；派生结果
//      非 null、端口 `s3_compatible`、批准能力是铸造产物；装进 `buildApp` 后 `mediaPort === 's3_compatible'`，
//      受理返回 202（不再是「带批准参数也恒拒」）。
//   ② **仍是 fail-closed**：不带启动参数（未批准）⇒ 不派生 ⇒ `unwired` ⇒ 受理 409 `OBJECT_UNAVAILABLE`
//      `retryable: false`，**没有**替身成功封套；real 缺凭据 ⇒ 更早的 503 `PROVIDER_UNAVAILABLE`
//      `retryable: false`。两条都不落任务、不产音频。
//   ③ **负控制**：把装配处那处注入去掉（= 修补前的 `server.ts` 形态）⇒ ① 的同一套断言必红
//      （`mediaPort` 回 `unwired`、受理回 409）——证明这些用例真的在看装配，不是在自言自语。
//
// 全部**离线**：真实端口由 `resolveMediaRealPorts` 在**保留域** `https://storage.example.test`（RFC 6761，
// 永不解析）上构造，本文件一次网络请求都不发；提供者是**会成功但不产真实音频**的测试脚本替身；
// 核对源是内存夹具。不构成任何真实 TTS／音质／真实桶往返的结论。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import {
  MEDIA_REAL_WIRING_FLAG,
  mediaRealPortsAssemblyOptions,
  resolveMediaRealPorts,
} from '../../services/api/src/media/real-ports.ts';
import { isRealSynthesisMediaWiringApproved } from '../../services/api/src/tts/media.ts';
import {
  SYNTHESIS_MEDIA_REAL_WIRING_REASON,
  synthesisMediaWiringAssemblyOptions,
} from '../../services/api/src/tts/real-ports.ts';
import { createMemoryCheckedContentPort } from '../../services/api/src/tts/content.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const SYNTHESIS_URL = '/api/v1/speech/synthesis';
const SECRET_MARKER = 'r68-synthetic-storage-secret-do-not-log';
const REF = { type: 'answer', id: 'answer-r68-approved', revision: 3 };

/** `OBJECT_STORAGE_*` 四键齐备的 `real` 配置（凭据是**明显合成的测试值**，不是任何真实 AK/SK）。 */
function realEnv(overrides = {}) {
  return {
    APP_EXECUTION_MODE: 'real',
    LOG_LEVEL: 'silent',
    // `real` 模式的其余必填项（与 `tests/unit/media-real-ports-wiring.test.mjs:49-68` 同形的合成占位，
    // 不是任何真实凭据；`DATABASE_URL` 指向永不可达的合成库，本文件只在内存存储上跑）。
    DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
    SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
    DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
    WECHAT_APP_ID: 'synthetic-not-a-real-appid',
    WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
    OBJECT_STORAGE_ENDPOINT: 'https://storage.example.test',
    OBJECT_STORAGE_BUCKET: 'gy-media',
    OBJECT_STORAGE_ACCESS_KEY: 'AKIDR68SYNTHETICONLY',
    OBJECT_STORAGE_SECRET_KEY: SECRET_MARKER,
    OBJECT_STORAGE_REGION: 'ap-shanghai',
    OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
    MEDIA_ACCESS_GRANT_ORIGIN: 'https://media.example.test',
    ...overrides,
  };
}

/** 自称 `persistent` 的内存 auth 存储（real 模式的会话闸门要求；只影响 auth 域）。 */
function persistentAuthStore() {
  const memory = createMemoryAuthStore();
  const store = Object.create(memory);
  Object.defineProperty(store, 'persistent', { value: true, enumerable: true });
  return store;
}

/** 已核对条目夹具（内存源，**不是**真实资料库，也**不是**真实审核结论）。 */
function contentPort() {
  return createMemoryCheckedContentPort([
    {
      type: REF.type,
      id: REF.id,
      revision: REF.revision,
      auditState: 'approved',
      text: '合成用例文本（内存夹具，非真实资料）：稻田稗草三到五叶期。',
      ownerUserId: null,
    },
  ]);
}

/**
 * `real` 分支的脚本提供者替身：**会成功**，但产物是 `ID3` + 5 字节载荷，**不是**任何真实音频。
 *
 * 用它把「受理是否被产物端口挡住」与「提供者是否可用」两件事分开：本文件要证的是**端口**这一道门。
 */
function scriptedRealProvider() {
  return {
    executionMode: 'real',
    providerVersion: 'scripted-real-r68-v1',
    note: '测试脚本提供者（非真实 TTS；不产生任何可播放音频，也不构成任何合成质量结论）',
    available: true,
    unavailableReason: null,
    async synthesize() {
      return {
        kind: 'completed',
        artifact: {
          contentType: 'audio/mpeg',
          body: Uint8Array.from([0x49, 0x44, 0x33, 0x01, 0x02]),
          substitute: false,
        },
      };
    },
  };
}

async function session(store) {
  const user = await store.createUser('ab'.repeat(32));
  const token = 'synthetic-r68-synthesis-token';
  await store.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 48 * 3600_000),
    audience: 'user',
  });
  return { user, token };
}

async function post(app, token, key) {
  const response = await app.inject({
    method: 'POST',
    url: SYNTHESIS_URL,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, 'content-type': 'application/json' },
    payload: JSON.stringify({ checked_content_ref: REF, locale: 'zh-CN' }),
  });
  let body = null;
  try { body = JSON.parse(response.body); } catch { body = null; }
  return { status: response.statusCode, body };
}

/** 生产入口（`server.ts`）源码——用来钉「这处装配真的在入口里发生」，而不是只在测试里发生。 */
function serverSource() {
  return readFileSync(resolve(ROOT, 'services/api/src/server.ts'), 'utf8');
}

// ---------------------------------------------------------------- ① 装配后不再恒 unwired

test('① real + 已批准 + 四键齐备 ⇒ synthesisMediaWiring 非 null（stub 模式语义不变）', async (t) => {
  // 结构面：派生必须发生在生产入口的同一次批准判定里（删掉那处注入 ⇒ 本用例红）。
  const server = serverSource();
  const branch = server.match(/if \(mediaRealPorts !== null\) \{\n[\s\S]*?\n {4}\}/);
  assert.ok(branch !== null, 'server.ts 必须有 `if (mediaRealPorts !== null) { … }` 判定块');
  assert.match(
    branch[0],
    /synthesisMediaAssembly = synthesisMediaWiringAssemblyOptions\(mediaRealPorts\);/,
    '生产入口必须在同一处批准判定里派生 synthesisMediaWiring（否则 TTS 恒 unwired）',
  );
  // ⚠ 2026-10-30（GY-R70 · 审核域批准通道）**有据变更，不是放宽**：入口的 `buildApp` 调用新增了
  //   第三个同族 spread（`moderationAssembly`，审核域独立的门，与媒体域判定解耦）。本钉子只把
  //   那条**新增的**实参登记进来，`logStream` 仍然注入不进来（第 168 行的断言一字未改）。
  assert.match(
    server,
    /const app = buildApp\(\{ config, pool, \.\.\.\(mediaAssembly \?\? \{\}\), \.\.\.\(synthesisMediaAssembly \?\? \{\}\), \.\.\.moderationAssembly \}\);/,
    '生产入口必须把派生结果传给 buildApp',
  );
  assert.equal(server.match(/synthesisMediaWiringAssemblyOptions\(/g)?.length, 1, '派生只允许一个来源');
  assert.equal(server.includes('logStream'), false, '补装配不得顺手引入测试专用注入项');

  // 行为面：走与 `server.ts` **同一条**路径（同一个 resolver、同一个派生函数），再交给 buildApp。
  const config = loadConfig(realEnv());
  assert.equal(config.executionMode, 'real');
  const ports = resolveMediaRealPorts({ config, argv: ['node', 'server.ts', MEDIA_REAL_WIRING_FLAG] });
  assert.notEqual(ports, null, '给了启动参数就必须解析出真实端口');
  const assembled = synthesisMediaWiringAssemblyOptions(ports);
  assert.deepEqual(Object.keys(assembled), ['synthesisMediaWiring'], '只产出这一个装配键');
  assert.equal(assembled.synthesisMediaWiring.objectStore, ports.objectStore, '必须复用同一个 S3 兼容端口');
  assert.equal(
    isRealSynthesisMediaWiringApproved(assembled.synthesisMediaWiring.realSynthesisMediaApproval),
    true,
    '批准能力必须是 approveRealSynthesisMediaWiring 的铸造产物（不是形状相同的字面量）',
  );
  assert.equal(assembled.synthesisMediaWiring.realSynthesisMediaApproval.reason, SYNTHESIS_MEDIA_REAL_WIRING_REASON);
  assert.equal(
    SYNTHESIS_MEDIA_REAL_WIRING_REASON.includes(MEDIA_REAL_WIRING_FLAG),
    true,
    '批准理由必须写明由哪个启动参数驱动（可 grep、可审查）',
  );

  const store = persistentAuthStore();
  const actor = await session(store);
  const app = buildApp({
    config,
    store,
    ...mediaRealPortsAssemblyOptions(ports),
    ...assembled,
    synthesisProvider: scriptedRealProvider(),
    synthesisContent: contentPort(),
  });
  t.after(() => app.close());

  const described = app.synthesisService.describe();
  assert.equal(described.mediaPort, 's3_compatible', '装配后 real 下产物端口必须不再是 unwired');
  assert.equal(described.mediaNote.includes('替身'), false, '真实端口不得自称替身');
  assert.equal(described.realAudioProduced, false, '本片不声称产生了真实音频');

  const accepted = await post(app, actor.token, 'r68-wired-accept');
  assert.equal(accepted.status, 202, `接线后受理必须是 202，实为 ${accepted.status} ${JSON.stringify(accepted.body)}`);
  assert.equal(accepted.body.data.state, 'queued');
  assert.equal(accepted.body.data.kind, 'synthesis');
  assert.equal(JSON.stringify(accepted.body).includes(SECRET_MARKER), false, '响应不得回显存储凭据');
});

// ---------------------------------------------------------------- ② 仍是 fail-closed

test('② 未批准/缺凭据 ⇒ 仍明确拒绝且 retryable:false，无替身成功封套、不落任务', async (t) => {
  const config = loadConfig(realEnv());

  // (a) 没有 `--approve-real-media-wiring` ⇒ resolver 返回 null ⇒ 生产入口不派生 ⇒ `unwired`。
  assert.equal(
    resolveMediaRealPorts({ config, argv: ['node', 'server.ts'] }),
    null,
    '没有启动参数时不得解析出真实端口（否则等于配置即门控）',
  );

  const store = persistentAuthStore();
  const actor = await session(store);
  const app = buildApp({
    config,
    store,
    synthesisProvider: scriptedRealProvider(),
    synthesisContent: contentPort(),
  });
  t.after(() => app.close());

  const described = app.synthesisService.describe();
  assert.equal(described.mediaPort, 'unwired', '未批准 ⇒ 产物端口必须仍未接线');
  assert.equal(described.mediaNote.includes('缺少合成产物真实存储接线的显式批准能力'), true, '未接线原因必须指向批准能力');

  const refused = await post(app, actor.token, 'r68-unwired-reject');
  assert.equal(refused.status, 409, '未接产物端口 ⇒ 409 OBJECT_UNAVAILABLE（不是 202）');
  assert.equal(refused.body.error.code, 'OBJECT_UNAVAILABLE');
  assert.equal(refused.body.error.retryable, false, '未接线需运维改配置，不是瞬时故障 ⇒ 不得标为可重试');
  assert.equal(refused.body.data, undefined, '**不得**返回替身成功封套');
  assert.equal(JSON.stringify(refused.body).includes('"substitute":true'), false, '不得以替身成功顶替');

  // 不落任务：与「作业不存在」同形 404，不谎称受理过。
  const missing = await app.inject({
    method: 'GET',
    url: '/api/v1/jobs/00000000-0000-4000-8500-00000000dead',
    headers: { authorization: `Bearer ${actor.token}` },
  });
  assert.equal(missing.statusCode, 404);

  // (b) real + 完全没凭据（默认装配、不注入可用提供者）⇒ 更早的 503 PROVIDER_UNAVAILABLE，仍 retryable:false。
  const bare = buildApp({ config, store, synthesisContent: contentPort() });
  t.after(() => bare.close());
  assert.equal(bare.synthesisService.describe().providerAvailable, false);
  const bareRefused = await post(bare, actor.token, 'r68-no-credential');
  assert.equal(bareRefused.status, 503, 'real 缺凭据必须 503 PROVIDER_UNAVAILABLE');
  assert.equal(bareRefused.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(bareRefused.body.error.retryable, false);
  assert.equal(bareRefused.body.data, undefined, '**不得**返回成功封套');

  // (c) `stub`/`preset_demo` 的既有行为不变：即便注入了真实接线选项，端口仍是**明确标注的替身**。
  const stubConfig = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  const ports = resolveMediaRealPorts({ config, argv: ['node', 'server.ts', MEDIA_REAL_WIRING_FLAG] });
  const stubApp = buildApp({
    config: stubConfig,
    store: createMemoryAuthStore(),
    ...synthesisMediaWiringAssemblyOptions(ports),
  });
  t.after(() => stubApp.close());
  assert.equal(
    stubApp.synthesisService.describe().mediaPort,
    'substitute',
    'stub 模式不得因注入真实端口而改变替身语义',
  );
});

// ---------------------------------------------------------------- ③ 负控制：撤掉注入即红

test('③ 负控制：去掉那处注入（= 修补前的 server.ts 形态）⇒ ① 的读数必红', async (t) => {
  const config = loadConfig(realEnv());
  const ports = resolveMediaRealPorts({ config, argv: ['node', 'server.ts', MEDIA_REAL_WIRING_FLAG] });
  const assembled = synthesisMediaWiringAssemblyOptions(ports);

  // 修补前的入口形态：只有媒体域的 spread，**没有**合成域的那一处（其余完全相同）。
  const preFixOptions = { ...mediaRealPortsAssemblyOptions(ports), synthesisProvider: scriptedRealProvider(), synthesisContent: contentPort() };

  const store = persistentAuthStore();
  const actor = await session(store);
  const preFix = buildApp({ config, store, ...preFixOptions });
  t.after(() => preFix.close());
  assert.equal(preFix.synthesisService.describe().mediaPort, 'unwired', '撤掉注入 ⇒ 产物端口必须回到 unwired');
  const refused = await post(preFix, actor.token, 'r68-negative-control');
  assert.equal(refused.status, 409, '撤掉注入 ⇒ 受理必须回到 409（① 的 202 因此是可被判红的）');
  assert.equal(refused.body.error.code, 'OBJECT_UNAVAILABLE');
  assert.equal(refused.body.error.retryable, false);

  // 同一份端口、同一份提供者、同一份核对源，只把那一处注入加回来 ⇒ 读数翻面（202 / s3_compatible）。
  const fixed = buildApp({ config, store, ...preFixOptions, ...assembled });
  t.after(() => fixed.close());
  assert.equal(fixed.synthesisService.describe().mediaPort, 's3_compatible', '加回注入 ⇒ 端口必须接线');
  const accepted = await post(fixed, actor.token, 'r68-negative-control-fixed');
  assert.equal(accepted.status, 202, '加回注入 ⇒ 受理必须 202');
});

// ---------------------------------------------------------------- ④ 入口不得读 ambient env（结构断言 + 负控制）

/**
 * 一段源码里 ambient env 的读取点计数（`process.env` 出现次数）；0 = 一次都不读。
 *
 * 为什么是计数而不是 `includes(...) === false`：计数让负控制有可读的读数（`1`），而不是只给
 * 一个布尔；两种写法在这里语义等价（0 ⇔ 完全不含）。
 */
function ambientEnvReads(text) {
  return (text.match(/process\.env/g) ?? []).length;
}

test('④ 入口不读 ambient env：server.ts 与本次新增的派生模块都是 0 处（负控制：塞一行即红）', () => {
  // 「两个端口都只能由 `--approve-real-media-wiring` 显式批准驱动」这句话的前提是入口**不读 env**：
  // 一旦入口按 ambient `OBJECT_STORAGE_*` 自己造端口，"配置即门控" 就回来了。此前没有任何用例
  // 直接钉这条（审查实测：把入口里的 env 读取压成一行、不动行数时，既有四条用例全绿）。
  const files = ['services/api/src/server.ts', 'services/api/src/tts/real-ports.ts'];
  const sources = files.map((rel) => readFileSync(resolve(ROOT, rel), 'utf8'));
  for (let index = 0; index < files.length; index += 1) {
    assert.equal(
      ambientEnvReads(sources[index]),
      0,
      `${files[index]} 不得读 ambient env（真实端口的唯一开启路径是启动参数，不是环境）`,
    );
  }
  // 负控制：把同一段源码拼上一行 env 读取，判据必须立刻变成 1（否则这条断言是空转的）。
  assert.equal(
    ambientEnvReads(`${sources[0]}\nconst r68Leak = process.env.R68_LEAK;\n`),
    1,
    '负控制：拼入一行 `process.env.X` 后判据必须红（证明它真的在看来源串）',
  );
  // 负控制之二：派生模块里塞一行同样要红（两个文件都在判据面内，不是只盯入口）。
  assert.equal(ambientEnvReads(`${sources[1]}\nconst r68Leak = process.env.R68_LEAK;\n`), 1);
  // 正向对照：入口确实读过 argv（同一族的显式启动面），否则上面的 0 可能只是因为整段被读空。
  assert.equal(/process\.argv\.slice\(2\)/.test(sources[0]), true, '入口必须从 argv 取启动参数');
});
