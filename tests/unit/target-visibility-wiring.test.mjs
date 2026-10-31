// GY-I16（#16 AC4）· 「本人识别 / OCR 历史」的**当前可见性接线**
// （`services/api/src/targetref/visibility-wiring.ts`）。
//
// 缺陷/授权/边界写在那个模块的文件头里；本文件只驱动两组东西：
//   ① **适配器本身**（零 I/O 的记录型替身）：按型别分派、三态判定、异常一律 fail-closed；
//   ② **生产装配可观测**（负控制锚点）：走 `app.ts` 那条生产默认 `defaultVisibility`，
//      断言历史投影里的 `reference_state`。把 `app.ts` 的 `ownedVisibility` 装配撤掉 ⇒ ② 全红，
//      而 ① 仍绿（替身是我写的）——所以两组都必须在，缺一组就等于自己证明自己。
//
// 不覆盖：真实 PG（本机起不了 PG，真库臂见 `tests/integration/favorites-history-pg.mjs` 与 CI）、
// 真实识别供应商/真实 OCR（仓内无凭据，属另一条链路）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import {
  OWNED_VISIBILITY_TARGET_TYPES,
  TARGET_VISIBILITY_DELEGATE,
  createTargetVisibilityWiring,
  isOwnedVisibilityTargetType,
} from '../../services/api/src/targetref/visibility-wiring.ts';

const OWNER = '00000000-0000-4000-8a00-0000000000a1';
const STRANGER = '00000000-0000-4000-8a00-0000000000a2';
const RECOGNITION_ID = '00000000-0000-4000-8b00-0000000000b1';
const OCR_ID = '00000000-0000-4000-8c00-0000000000c1';
const JOB_ID = '00000000-0000-4000-8d00-0000000000d1';
const ABSENT_ID = '00000000-0000-4000-8e00-0000000000ff';
const MEDIA_ID = '00000000-0000-4000-8f00-0000000000f1';

/** owner 读面在「他人的 / 不存在的 / 非 UUID」三档上的**同形**错误（`ApiError('NOT_FOUND')`，无 message 依赖）。 */
const apiError = (code) => Object.assign(new Error(`synthetic ${code}`), { code });

/**
 * 记录型读面替身：只记录入参、不 I/O。
 * `outcome` 是记录/空/别的 id/异常四类之一（可以是函数：按入参算），用来构造四种读面结果。
 */
function face({ method, outcome }) {
  const calls = [];
  const handler = async (input) => {
    calls.push(input);
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === 'function') return outcome(input);
    return outcome;
  };
  return { calls, api: { [method]: handler } };
}

/** 闭包取服务（与 `app.ts` 的装配同形）：`resolved` 计数＝闭包被执行了几次＝是否真的在请求期解析。 */
function servicesOf({ recognition, ocr }) {
  const resolved = { recognition: 0, ocr: 0 };
  return {
    resolved,
    services: {
      recognitionService: () => {
        resolved.recognition += 1;
        return recognition.api;
      },
      ocrService: () => {
        resolved.ocr += 1;
        return ocr.api;
      },
    },
  };
}

const recognitionFace = (outcome) => face({ method: 'getRecognition', outcome });
const ocrFace = (outcome) => face({ method: 'getOcr', outcome });

const recognitionRef = (overrides = {}) => ({ type: 'recognition', id: RECOGNITION_ID, revision: 3, ...overrides });
const ocrRef = (overrides = {}) => ({ type: 'ocr', id: OCR_ID, revision: 2, ...overrides });

// ===========================================================================
// 1. 闭集与分派：只有 recognition / ocr 归本文件管，其余一律 delegate（原样交回既有逻辑）
// ===========================================================================

test('可见性接线：闭集恰为 recognition / ocr（型别判定与 TARGET_REF_TYPES 的子集关系）', () => {
  assert.deepEqual([...OWNED_VISIBILITY_TARGET_TYPES], ['recognition', 'ocr']);
  assert.equal(isOwnedVisibilityTargetType('recognition'), true);
  assert.equal(isOwnedVisibilityTargetType('ocr'), true);
  // 收藏闭集三型 + 其余目标域 + 非字符串：都不归本片管（⛔ 不得顺手扩成「都算可用」）。
  for (const type of ['species', 'herbicide', 'scheme', 'media', 'dose_card', 'conversation', 'widget', '', null, 42]) {
    assert.equal(isOwnedVisibilityTargetType(type), false, `${String(type)} 不得被当成本片负责的型别`);
  }
});

test('可见性接线：species/herbicide/scheme 与其余型别 ⇒ delegate，且**一次读面都不碰**（既有行为不变）', async () => {
  const recognition = recognitionFace({ id: RECOGNITION_ID });
  const ocr = ocrFace({ id: OCR_ID });
  const { services, resolved } = servicesOf({ recognition, ocr });
  const wiring = createTargetVisibilityWiring(services);

  for (const type of ['species', 'herbicide', 'scheme', 'media', 'dose_card', 'widget']) {
    assert.equal(
      await wiring.resolve({ type, id: RECOGNITION_ID, revision: 1 }, OWNER),
      TARGET_VISIBILITY_DELEGATE,
      `${type} 必须原样交回既有逻辑（不得在本文件里判可用/不可用）`,
    );
  }
  assert.deepEqual(recognition.calls, [], '非本片型别不得触发识别 owner 读面');
  assert.deepEqual(ocr.calls, [], '非本片型别不得触发 OCR owner 读面');
  assert.deepEqual(resolved, { recognition: 0, ocr: 0 }, '装饰闭包也不得被解析（一次都没有调用）');
});

// ===========================================================================
// 2. 识别腿：本人 ⇒ available；他人/不存在/读面报错/读面返空/返回别的 id ⇒ unavailable
// ===========================================================================

test('可见性接线·识别：本人记录 ⇒ available（用**会话主体**的 userId 与 target_ref.id 去读）', async () => {
  const recognition = recognitionFace((input) => ({ id: input.recognitionId, revision: 9 }));
  const ocr = ocrFace(null);
  const { services } = servicesOf({ recognition, ocr });
  const wiring = createTargetVisibilityWiring(services);

  assert.equal(await wiring.resolve(recognitionRef(), OWNER), 'available');
  assert.deepEqual(recognition.calls, [{ userId: OWNER, recognitionId: RECOGNITION_ID }], '入参必须恰是 (userId, recognitionId)');
  assert.deepEqual(ocr.calls, [], '识别腿不得顺带读 OCR 域');
});

test('可见性接线·识别：他人记录（读面按 userId 抛 NOT_FOUND）⇒ unavailable', async () => {
  const recognition = recognitionFace(apiError('NOT_FOUND'));
  const { services } = servicesOf({ recognition, ocr: ocrFace(null) });
  const wiring = createTargetVisibilityWiring(services);

  assert.equal(await wiring.resolve(recognitionRef(), STRANGER), 'unavailable');
  assert.deepEqual(recognition.calls, [{ userId: STRANGER, recognitionId: RECOGNITION_ID }], '必须拿**当前会话主体**去问，不得猜 owner');
});

test('可见性接线·识别：查不到 / 非 UUID（读面同形 404）⇒ unavailable，且读面调用次数＝1（不重试放大）', async () => {
  const recognition = recognitionFace(apiError('NOT_FOUND'));
  const { services } = servicesOf({ recognition, ocr: ocrFace(null) });
  const wiring = createTargetVisibilityWiring(services);

  assert.equal(await wiring.resolve(recognitionRef({ id: ABSENT_ID }), OWNER), 'unavailable');
  assert.equal(await wiring.resolve(recognitionRef({ id: 'rec-page-1' }), OWNER), 'unavailable', '非 UUID 的历史 target_ref.id 也必须折叠成 unavailable');
  assert.equal(recognition.calls.length, 2);
});

test('可见性接线·识别：读面抛任意非契约异常（存储故障/装配缺失）⇒ unavailable（fail-closed，不向上抛）', async () => {
  for (const boom of [new Error('connection reset'), new TypeError('x is not a function'), apiError('FORBIDDEN')]) {
    const recognition = recognitionFace(boom);
    const { services } = servicesOf({ recognition, ocr: ocrFace(null) });
    const wiring = createTargetVisibilityWiring(services);
    assert.equal(await wiring.resolve(recognitionRef(), OWNER), 'unavailable', `${boom.constructor.name} 必须折叠成 unavailable`);
  }
});

test('可见性接线·识别：读面返回空/非对象/别的 id ⇒ 仍 unavailable（⛔「读了个空」不得当「可用」）', async () => {
  const cases = [
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'ok'],
    ['空对象', {}],
    ['id 为空串', { id: '' }],
    ['id 是数字', { id: 7 }],
    ['别的记录', { id: ABSENT_ID }],
  ];
  for (const [label, outcome] of cases) {
    const { services } = servicesOf({ recognition: recognitionFace(outcome), ocr: ocrFace(null) });
    assert.equal(await createTargetVisibilityWiring(services).resolve(recognitionRef(), OWNER), 'unavailable', `${label} ⇒ unavailable`);
  }
});

// ===========================================================================
// 3. OCR 腿：与识别腿同口径（参数化四档）
// ===========================================================================

test('可见性接线·OCR：本人 ⇒ available；他人/不存在/抛错/返空 ⇒ unavailable（四档参数化）', async () => {
  const cases = [
    ['本人记录', (input) => ({ id: input.ocrId, revision: 4 }), 'available'],
    ['他人记录', apiError('NOT_FOUND'), 'unavailable'],
    ['查不到', apiError('NOT_FOUND'), 'unavailable'],
    ['读面抛错', new Error('connection reset'), 'unavailable'],
    ['读面返空', null, 'unavailable'],
    ['返回别的记录', { id: ABSENT_ID }, 'unavailable'],
  ];
  for (const [label, outcome, expected] of cases) {
    const ocr = ocrFace(outcome);
    const recognition = recognitionFace(null);
    const { services } = servicesOf({ recognition, ocr });
    const wiring = createTargetVisibilityWiring(services);
    assert.equal(await wiring.resolve(ocrRef(), STRANGER), expected, `${label} ⇒ ${expected}`);
    assert.deepEqual(ocr.calls, [{ userId: STRANGER, ocrId: OCR_ID }], `${label}：入参必须恰是 (userId, ocrId)`);
    assert.deepEqual(recognition.calls, [], `${label}：OCR 腿不得顺带读识别域`);
  }
});

// ===========================================================================
// 4. 装配顺序：闭包**请求期**解析（装配期不解析、每次 resolve 解析一次）；解析失败 ⇒ unavailable
// ===========================================================================

test('可见性接线：闭包在请求期解析（构造时不解析、每次 resolve 解析一次）；解析抛错 ⇒ unavailable', async () => {
  const recognition = recognitionFace({ id: RECOGNITION_ID });
  const { services, resolved } = servicesOf({ recognition, ocr: ocrFace(null) });
  const wiring = createTargetVisibilityWiring(services);
  assert.deepEqual(resolved, { recognition: 0, ocr: 0 }, '构造期不得解析服务（那时 decorate 还没发生）');

  assert.equal(await wiring.resolve(recognitionRef(), OWNER), 'available');
  assert.equal(await wiring.resolve(recognitionRef(), OWNER), 'available');
  assert.equal(resolved.recognition, 2, '每次 resolve 解析一次（不缓存实例）');

  // 装饰尚未发生 / 装配缺失：闭包自己抛 ⇒ 折叠成 unavailable，绝不向上抛。
  const broken = createTargetVisibilityWiring({
    recognitionService: () => {
      throw new TypeError('recognitionService 装饰尚未发生');
    },
    ocrService: () => {
      throw new TypeError('ocrService 装饰尚未发生');
    },
  });
  assert.equal(await broken.resolve(recognitionRef(), OWNER), 'unavailable');
  assert.equal(await broken.resolve(ocrRef(), OWNER), 'unavailable');

  // 闭包返回 null（替身/未来实现没给对象）：不得调方法、不得抛，判 unavailable。
  const empty = createTargetVisibilityWiring({ recognitionService: () => null, ocrService: () => null });
  assert.equal(await empty.resolve(recognitionRef(), OWNER), 'unavailable');
  assert.equal(await empty.resolve(ocrRef(), OWNER), 'unavailable');
});

// ===========================================================================
// 5. **生产装配**可观测（负控制锚点）：撤掉 `app.ts` 的 ownedVisibility 装配 ⇒ 本节全红
// ===========================================================================

const HISTORY_URL = '/api/v1/history';
const START = Date.UTC(2026, 10, 1, 6);

/** 一条真实的（内存）识别行：`getRecognition` 直接读它（形状同 `recognitions/store.ts` 的存储行）。 */
function recognitionRows(ownerUserId, recognitionId, jobId) {
  return {
    job: {
      id: jobId,
      revision: 2,
      kind: 'recognition',
      ownerUserId,
      recognitionId,
      mediaId: '00000000-0000-4000-9000-000000000001',
      mediaRevision: 1,
      state: 'succeeded',
      deadlineAt: new Date(START + 60_000),
      createdAt: new Date(START),
      updatedAt: new Date(START + 1000),
      errorCode: null,
    },
    recognition: {
      id: recognitionId,
      revision: 2,
      ownerUserId,
      mediaId: '00000000-0000-4000-9000-000000000001',
      mediaRevision: 1,
      candidates: [{ species_id: 'spc-model-1', rank: 1, model_score: 0.82 }],
      uncertaintyReasons: [],
      selectedSpeciesId: null,
      modelVersion: 'model-synthetic-v1',
      createdAt: new Date(START),
      updatedAt: new Date(START + 1000),
      deleted: false,
    },
  };
}

/**
 * 默认装配（stub + 内存 store）：**不注入** `historyInjection`，
 * 因此历史可用性走的就是 `app.ts` 里那条生产默认值 —— 本组用例断言的正是它。
 */
async function assemblyFixture(t, { ownedRecognition = false } = {}) {
  const auth = createMemoryAuthStore();
  const recognitionStore = createMemoryRecognitionStore();
  const config = { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }) };
  const app = buildApp({ config, store: auth, now: () => new Date(START), recognitionStore });
  t.after(() => app.close());

  const tokens = {};
  const users = {};
  for (const [name, fill] of [['owner', 'a'], ['stranger', 'b']]) {
    const user = await auth.createUser(fill.repeat(64));
    const token = `synthetic-i16-visibility-${name}`;
    await auth.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(START + 48 * 3600_000),
      audience: 'user',
    });
    users[name] = user;
    tokens[name] = token;
  }
  for (const row of ownedRecognition ? [recognitionRows(users.owner.id, RECOGNITION_ID, JOB_ID)] : []) {
    await recognitionStore.insertJob(row.job);
    await recognitionStore.insertRecognition(row.recognition);
  }

  const appendTo = (userId, overrides = {}) =>
    app.historyService.appendHistory({
      owner_id: userId,
      kind: 'recognition',
      target_ref: { type: 'recognition', id: RECOGNITION_ID, revision: 2 },
      job_id: JOB_ID,
      job_state: 'succeeded',
      event_key: 'recognition:visibility-wiring-1',
      ...overrides,
    });

  const history = async (name) => {
    const response = await app.inject({
      method: 'GET',
      url: HISTORY_URL,
      headers: { authorization: `Bearer ${tokens[name]}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data.items;
  };

  return { app, recognitionStore, users, tokens, appendTo, history };
}

test('可见性接线·生产装配：本人识别记录 ⇒ reference_state=available；同一条写进**别人**历史 ⇒ unavailable', async (t) => {
  const f = await assemblyFixture(t, { ownedRecognition: true });
  const ownerId = f.users.owner.id;
  await f.appendTo(ownerId, {});
  const own = await f.history('owner');
  assert.equal(own.length, 1);
  assert.deepEqual(own[0].target_ref, { type: 'recognition', id: RECOGNITION_ID, revision: 2 });
  assert.equal(
    own[0].reference_state,
    'available',
    '本人识别历史必须判 available（撤掉 app.ts 的 ownedVisibility 装配 ⇒ 这里退回恒 unavailable ⇒ 红）',
  );

  // 成对的反面：同一条记录写进**别人**的历史 ⇒ owner 读面按 userId 抛 404 ⇒ 仍 unavailable。
  await f.appendTo(f.users.stranger.id, { event_key: 'recognition:visibility-wiring-foreign-1' });
  const foreign = await f.history('stranger');
  assert.equal(foreign.length, 1);
  assert.equal(
    foreign[0].reference_state,
    'unavailable',
    '别人的识别记录不得判可用（否则等于凭空确认他人资源的存在性）',
  );
});

test('可见性接线·生产装配：识别记录不存在 / 已不在读面 ⇒ unavailable（不得因「历史行指向它」就判可用）', async (t) => {
  const f = await assemblyFixture(t);
  await f.appendTo(f.users.owner.id, { target_ref: { type: 'recognition', id: ABSENT_ID, revision: 2 } });
  const items = await f.history('owner');
  assert.equal(items.length, 1);
  assert.equal(items[0].reference_state, 'unavailable');
});

test('可见性接线·生产装配：未接线的目标域（media）⇒ 仍恒 unavailable（本片没解决的那一半）', async (t) => {
  const f = await assemblyFixture(t);
  await f.appendTo(f.users.owner.id, {
    target_ref: { type: 'media', id: MEDIA_ID, revision: 1 },
    event_key: 'recognition:visibility-wiring-media-1',
  });
  const items = await f.history('owner');
  assert.equal(items.length, 1);
  assert.equal(items[0].reference_state, 'unavailable', '媒体/剂量卡/会话等目标域本片未接线，必须如实 unavailable');
});

test('可见性接线·生产装配回归：既有闭集（species）行为与改前逐字相同（无 knowledge 读面 ⇒ unavailable）', async (t) => {
  const f = await assemblyFixture(t);
  await f.appendTo(f.users.owner.id, {
    target_ref: { type: 'species', id: 'spc-1', revision: 1 },
    event_key: 'recognition:visibility-wiring-species-1',
  });
  const items = await f.history('owner');
  assert.equal(items.length, 1);
  // 装配里没有 pool、种子面也没有这条 ⇒ 与改前一致：核不到 ⇒ unavailable（本片**没有**给它造读面）。
  assert.equal(items[0].reference_state, 'unavailable');
});
