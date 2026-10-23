// GY-I16（#16）· 收藏／历史的**两账号**隔离集成回归：本机 loopback **真实 HTTP**（127.0.0.1 + fetch），
// execution_mode=stub + 合成身份（替身登录）+ 内存 store；无 PG、无微信开发者工具、无外网、无付费调用。
//
// 运行：node tests/integration/favorites-history-isolation-http.mjs
// 退出码 0 表示通过；任何断言失败以非 0 退出并打印原始断言（不跳过、不吞错、不报绿）。
//
// 与既有 `tests/unit/favorites-http.test.mjs` **不重复**：那份是**单域**单元面（去重、幂等、CAS、
// 校验、游标、real 关闭），且历史域只经服务层内部口落行；本脚本补的是**两账号 × 两条私有域 × 真实 HTTP**
// 的跨账号隔离与"删除后不可取回／失效不因缓存复活"，历史行由**真实识别任务终态**驱动（不是内部口）。
//
// 可注入替身（如实声明，不得当作真实读面证据）：
//   - 会话身份：`buildApp({ store: createMemoryAuthStore(), now })` + 合成令牌（替身登录，非真实微信）；
//   - **引用可用性端口**：`favoritesInjection.visibility` / `historyInjection.visibility` 注入下述可控替身。
//     生产缺省端口是 `services/api/src/app.ts` 的 `defaultVisibility`（核验公开读面
//     `catalog_read.current_knowledge`，且 `type`/`revision` 逐项一致才判可用；无库时恒核不到 ⇒ unavailable）。
//     本脚本的替身**沿用同一"逐项一致"口径**（type+id+revision+账号全部匹配才算可用），只为让
//     "下架/失效/版本变更"与"逐账号可见"可在无库环境里被**确定性复现**；
//   - 识别：`createStubRecognitionProvider()` + `createSubstituteMediaPort()`（不接真实供应商、不上传真实照片）。
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { favoriteEligibleForRecommendation } from '../../services/api/src/favorites/service.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createStubRecognitionProvider } from '../../services/api/src/recognitions/provider.ts';
import { createSubstituteMediaPort } from '../../services/api/src/recognitions/media.ts';
import { createWiredVisibilityPort } from '../../services/api/src/targetref/visibility.ts';

const FAVORITES = '/api/v1/favorites';
const HISTORY = '/api/v1/history';
const RECOGNITIONS = '/api/v1/recognitions';
const JOBS = '/api/v1/jobs';
const LOGIN = '/api/v1/auth/wechat';

// 替身脚本按 media_id 的 sha256 分桶（services/api/src/recognitions/provider.ts）：该 id 落在
// 「2 条候选、全有分数」桶 ⇒ 终态 succeeded（与既有 tests/integration/recognitions-http.mjs 同源）。
const MEDIA_ID = '11111111-1111-4111-8111-111111111111';
const TERMINAL_JOB_STATES = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];
/** `History` 契约的键集（`additionalProperties:false` 的逐字段比对基准）。 */
const HISTORY_KEYS = ['created_at', 'id', 'job_state', 'kind', 'reference_state', 'revision', 'target_ref'];
/** 一个**不存在**的合法 uuid（用于「他人资源」与「完全不存在」的同形比较）。 */
const ABSENT_ID = '00000000-0000-4000-8f00-0000000000ff';
const START = Date.UTC(2026, 9, 14, 8, 0, 0);

/** 脚本化时钟：确定性 created_at（不是"时间无关"的断言，只为可复现）。 */
function scriptedClock(baseMs) {
  let ms = baseMs;
  return {
    now: () => new Date(ms),
    advance: (deltaMs) => {
      ms += deltaMs;
      return ms;
    },
  };
}

/**
 * **可控可见性替身**（不是真实可见性核验实现）。
 *
 * `available` 是 `(type, id, revision, userId)` 四元组的集合，`resolve` 严格按四元组匹配 ⇒
 * 与生产端口的"type/revision 逐项一致才判可用"同口径。据此：
 *   - `unpublish(type,id,rev)` ⇒ 模拟下架/失效/删除：**同一行旧收藏**在下一次读取即为 unavailable；
 *   - `publish(type,id,rev新)` ⇒ 模拟对象以**新版本**重新公开：旧 revision 的引用**仍不可用**
 *     （不得凭新版本或缓存把旧引用复活）。
 * `calls` 记录每次派生（含 userId），用于证明"逐次重查"与"从未替他人账号核验我的目标"。
 */
function makeControllableVisibility() {
  const available = new Set();
  const calls = [];
  /** 观察到的主体（服务端会话里的 userId；脚本不预设它的取值，只如实记录）。 */
  const subjects = { A: null, B: null };
  const keyOf = (target, userId) => `${target.type}:${target.id}:${target.revision}:${userId}`;
  const port = createWiredVisibilityPort({
    note: '集成回归替身：可用性由用例按 (type,id,revision,账号) 控制（不是真实可见性核验实现）',
    resolve: async ({ target_ref, userId }) => {
      calls.push({ type: target_ref.type, id: target_ref.id, revision: target_ref.revision, userId });
      // 观察型记录：第一次被核验的主体记为 A，与 A 不同的记为 B（用于 ③ 的"按账号分别派生"）。
      if (subjects.A === null) subjects.A = userId;
      else if (userId !== subjects.A) subjects.B = userId;
      return available.has(keyOf(target_ref, userId)) ? 'available' : 'unavailable';
    },
  });
  return {
    port,
    calls,
    subjects,
    /** 清空派生日志：登录夹具的"见证收藏"属于夹具噪音，清零后 `calls` 只记录用例自身的派生。 */
    clear: () => {
      calls.length = 0;
    },
    publish: (target, userId) => available.add(keyOf(target, userId)),
    unpublish: (target, userId) => available.delete(keyOf(target, userId)),
  };
}

const evidence = [];
function note(kind, text) {
  const line = `[GY-I16-E2E] ${kind} ${text}`;
  evidence.push(line);
  console.log(line);
}
function listItems(body) {
  return body && body.data && Array.isArray(body.data.items) ? body.data.items : null;
}
function itemById(body, id) {
  const items = listItems(body);
  return items === null ? null : (items.find((item) => item.id === id) ?? null);
}

// 断言失败必须**有界地**以非 0 退出：用例③/④ 也各自 `await fixture()` 新建监听中的服务，若失败路径
// 不关掉它们，事件循环永不退出 ⇒ 本地"红"会退化成 CI 上"挂到该 job 的 `timeout-minutes` 才被杀"
// （`.github/workflows/engineering-shell.yml` 全部 7 个 job 都设了 `timeout-minutes: 15`，`integration`
// job 亦然；而 `package.json` 的 `test:integration:http` 是 `&&` 串联：一个进程不返回则整链不返回
// ⇒ 15 分钟内拿不到任何有意义的失败点，只看到一条超时）。
// ⇒ 把每个已开的 app 登记在册，失败时统一关闭、再确定性退出。
const openApps = new Set();
async function closeAllFixtures() {
  for (const app of openApps) {
    try {
      await app.close();
    } catch {
      // 关闭失败不得掩盖原始断言（原始错误已打印在 catch 内）
    }
  }
  openApps.clear();
}

async function fixture() {
  const clock = scriptedClock(START);
  const visibility = makeControllableVisibility();
  const auth = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store: auth,
    now: clock.now,
    favoritesInjection: { store: createMemoryFavoritesStore({ now: () => clock.ms }), visibility: visibility.port },
    historyInjection: { store: createMemoryHistoryStore({ now: () => clock.ms }), visibility: visibility.port },
    recognitionStore: createMemoryRecognitionStore(),
    recognitionProvider: createStubRecognitionProvider(),
    recognitionMedia: createSubstituteMediaPort(),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  openApps.add(app);
  const address = app.server.address();
  assert.equal(typeof address, 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    return await buildHandle();
  } catch (error) {
    // 装配/登录阶段失败也要关掉监听中的服务（诚实失败，不挂死进程）。
    openApps.delete(app);
    await app.close().catch(() => {});
    throw error;
  }

  async function buildHandle() {

  let idempotencyCounter = 0;
  // 幂等键：全局单调序号 ⇒ 同一调用点在脚本里被调用多次也**必然**得到不同键
  // （否则重放会返回上一次的结果，把"删除不可取回"的断言顶掉成假绿）。
  function idem(label) {
    idempotencyCounter += 1;
    return `gy-i16-e2e-${label}-${String(idempotencyCounter).padStart(4, '0')}`;
  }
  async function http(path, options = {}) {
    const response = await fetch(base + path, options);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return {
      status: response.status,
      body,
      etag: response.headers.get('etag'),
      cache: response.headers.get('cache-control'),
      cascade: response.headers.get('x-gy-cascade'),
    };
  }
  function json(token, extra = {}) {
    // 无请求体时不声明 content-type（既有回环脚本口径）；DELETE 的"微信默认 JSON 头"整类缺陷
    // 已由 tests/unit/favorites-http.test.mjs 单独覆盖，本脚本不重复。
    return {
      ...extra,
      headers: {
        ...(extra.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === null ? {} : { authorization: 'Bearer ' + token }),
        ...(extra.headers ?? {}),
      },
    };
  }
  /** 替身登录：同一 code ⇒ 同一账号；不同 code ⇒ 不同账号（合成身份，非真实微信）。 */
  async function login(code, seed) {
    const response = await http(LOGIN, json(null, {
      method: 'POST',
      headers: { 'idempotency-key': idem(`login-${seed}`) },
      body: JSON.stringify({ code }),
    }));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const token = response.body.data.access_token;
    // 契约的会话响应**不含** userId（openapi Session 只有 access_token/token_type/expires_at/audience/revision，
    // `GET /auth/session` 亦不同）⇒ 这里不编造账号 id，而是让替身端口**观察服务端会话里的主体 id**：
    // 建一条"见证收藏"（其后立刻取消，列表保持干净）。第一次派生到的主体就是本会话主体。
    const witness = await createFavorite(token, { type: 'scheme', id: `00000000-0000-4000-8e00-${seed === 'a' ? '00000000000a' : '00000000000b'}`, revision: 1 }, `login-witness-${seed}`);
    const cleared = await deleteFavorite(token, witness.favorite.id, witness.favorite.revision, `login-witness-del-${seed}`);
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    return token;
  }
  async function createFavorite(token, target, label) {
    const response = await http(FAVORITES, json(token, {
      method: 'POST',
      headers: { 'idempotency-key': idem(label) },
      body: JSON.stringify({ target_ref: target }),
    }));
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { response, favorite: response.body.data };
  }
  async function deleteFavorite(token, id, revision, label) {
    return http(`${FAVORITES}/${id}`, json(token, {
      method: 'DELETE',
      headers: { 'idempotency-key': idem(label), 'if-match': `"${revision}"` },
    }));
  }
  async function deleteHistory(token, id, revision, label) {
    return http(`${HISTORY}/${id}`, json(token, {
      method: 'DELETE',
      headers: { 'idempotency-key': idem(label), 'if-match': `"${revision}"` },
    }));
  }

  // 会话对象带 `label`（仅用于 note 文案）：反向控制脚本把 B 的 token 与它对应的主体一起换成 A 的 ⇒ 断言必须变红。
  const sessionA = { label: 'A', token: await login('gy-i16-e2e-account-a', 'a') };
  // 见证收藏那次派生观察到的主体就是会话 A 的主体（跨 FAVORITES 与 HISTORY 两个端口实例共用同一份 `subjects`）。
  const userA = visibility.subjects.A;
  const sessionB = { label: 'B', token: await login('gy-i16-e2e-account-b', 'b') };
  let userB = visibility.subjects.B;
  // 两次登录各建/删一条见证收藏并各触发一次派生 ⇒ 恰好观察到两个**不同**主体（登录响应本身不含 userId）。
  assert.notEqual(sessionA.token, sessionB.token, '两个合成身份必须是两个不同账号');
  assert.equal(typeof userA, 'string', `见证派生未观察到主体 A：${JSON.stringify(visibility.calls)}`);
  assert.equal(typeof userB, 'string', `见证派生未观察到主体 B：${JSON.stringify(visibility.calls)}`);
  assert.notEqual(userA, userB, '两个合成身份必须是两个不同账号（服务端主体不同）');
  assert.deepEqual(
    [...new Set(visibility.calls.map((call) => call.userId))].sort(),
    [userA, userB].sort(),
    '登录夹具阶段只应观察到这两个主体',
  );
  // 夹具噪音（两条见证收藏的派生）到此为止：清零后 `visibility.calls` 只记录用例自身的派生。
  visibility.clear();
  // —— 反向控制开关（默认关闭，正常门禁不受影响）——
  // `GY_I16_SWAP_B_TO_A=1` 把"会话 B"换成会话 A 的凭据与主体。断言**一字未改**：若用例真的验证了
  // 私有隔离与越权拒绝，它必须因此变红；若仍然绿，说明断言是空的（假绿）。**不复制、不改写任何文件**，
  // 运行方式与自证见同目录 `favorites-history-isolation-http.reverse-control.mjs`。
  if (process.env.GY_I16_SWAP_B_TO_A === '1') {
    const tokenBeforeSwap = sessionB.token;
    const userBeforeSwap = userB;
    sessionB.token = sessionA.token;
    userB = userA;
    // 自证"确实换掉了"：换之前 B 的凭据与主体都与 A 不同；否则反向控制会假红在夹具处。
    assert.notEqual(tokenBeforeSwap, sessionA.token, '反向控制前置：换之前 B 的令牌必须不同于 A');
    assert.notEqual(userBeforeSwap, userA, '反向控制前置：换之前 B 的主体必须不同于 A');
    assert.equal(sessionB.token, sessionA.token, '反向控制前置：B 的令牌必须已换成 A 的');
    assert.equal(userB, userA, '反向控制前置：B 的主体必须已换成 A 的');
    note('reverse-control', '已按 GY_I16_SWAP_B_TO_A=1 把会话 B 换成会话 A（断言未改，应当变红）');
  }

  return {
    app,
    base,
    clock,
    auth,
    visibility,
    http,
    json,
    login,
    idem,
    createFavorite,
    deleteFavorite,
    deleteHistory,
    sessionA,
    sessionB,
    userA,
    userB,
  };
  }
}

/**
 * ① 私有隔离：B 看不到 A 的收藏/历史；B 直接拿 A 的资源 id ⇒ **非成功**（不是"200 但列表为空"）。
 *
 * 返回共享上下文（同一 app 实例）供 ② 继续在同一份数据上做"删除不可取回"。
 */
async function testPrivateIsolation(h) {
  const { sessionA, sessionB, userA, userB, visibility, http, json } = h;
  const a = { type: 'species', id: '00000000-0000-4000-8a00-0000000000a1', revision: 3 };
  const shared = { type: 'herbicide', id: '00000000-0000-4000-8b00-0000000000b1', revision: 2 };
  // 目标只对 A 可见（B 的账号核不到该四元组）⇒ 若 B 能看到该行，其 reference_state 必为 unavailable。
  visibility.publish(a, userA);
  visibility.publish(shared, userA);

  const created = await h.createFavorite(sessionA.token, a, 'fav-a');
  const favorite = created.favorite;
  assert.equal(favorite.reference_state, 'available');
  assert.equal(favorite.unavailable_reason, null);
  assert.equal(created.response.etag, `"${favorite.revision}"`);
  assert.equal(created.response.cache, 'no-store');

  const aList = await http(FAVORITES, json(sessionA.token));
  assert.equal(aList.status, 200);
  assert.equal(aList.cache, 'no-store');
  assert.equal(aList.etag, null, '列表不得回 ETag（契约：资源 revision 强 ETag；列表无此头）');
  assert.deepEqual(listItems(aList.body).map((item) => item.id), [favorite.id]);
  assert.equal(itemById(aList.body, favorite.id).reference_state, 'available');

  // B 的列表：看不到 A 的收藏（恰为空，且不是"被不可用遮住的一行"）。
  const bList = await http(FAVORITES, json(sessionB.token));
  assert.equal(bList.status, 200);
  assert.deepEqual(bList.body.data, { items: [], next_cursor: null }, '私有隔离：B 的列表不得看到 A 的收藏');

  // B 直接拿 A 的**收藏 id** 做删除：必须非成功（404 NOT_FOUND），且与"完全不存在的 id"**逐字段同形**。
  // 如实口径：收藏域**没有** `GET /favorites/{id}` 详情路由（`services/api/src/routes/favorites.ts` 只注册
  // `GET /favorites` 列表、`POST /favorites`、`DELETE /favorites/{id}`）⇒ 越权**读取**只可能发生在列表上，
  // 本脚本**不声称**断言过不存在的详情路径（历史侧同一现象见下方 `GET /history/{id}` 未注册断言）。
  const foreignDelete = await h.deleteFavorite(sessionB.token, favorite.id, favorite.revision, 'fav-b');
  const absentDelete = await h.deleteFavorite(sessionB.token, ABSENT_ID, 1, 'fav-b');
  assert.equal(foreignDelete.status, 404);
  assert.equal(foreignDelete.body.error.code, 'NOT_FOUND');
  assert.deepEqual(foreignDelete.body.error, absentDelete.body.error, '他人收藏与不存在必须同形（不泄露存在性）');
  // 说明（如实口径）：错误响应由全局错误处理器生成，**不继承**路由层的 `Cache-Control: no-store`
  // （既有 tests/** 也只在成功响应上断言该头）。这里不断言 404 的缓存头，只断言"不含任何存在性信息"。

  // —— 历史：由**真实识别任务的终态**驱动（不是内部创建口）——
  const createdJob = await http(RECOGNITIONS, json(sessionA.token, {
    method: 'POST',
    headers: { 'idempotency-key': h.idem('rec-a') },
    body: JSON.stringify({ media_id: MEDIA_ID, media_revision: 1 }),
  }));
  assert.equal(createdJob.status, 202, JSON.stringify(createdJob.body));
  assert.equal(createdJob.body.data.state, 'queued');
  const jobId = createdJob.body.data.id;
  let job = createdJob.body.data;
  for (let i = 0; i < 200 && !TERMINAL_JOB_STATES.includes(job.state); i += 1) {
    const polled = await http(`${JOBS}/${jobId}`, json(sessionA.token));
    assert.equal(polled.status, 200);
    job = polled.body.data;
    if (!TERMINAL_JOB_STATES.includes(job.state)) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(TERMINAL_JOB_STATES.includes(job.state), `识别任务未到终态：${job.state}`);
  assert.equal(job.state, 'succeeded', JSON.stringify(job.error_code));
  const recognitionId = job.target_ref.id;
  assert.equal(job.target_ref.type, 'recognition');

  const historyPage = await http(HISTORY, json(sessionA.token));
  assert.equal(historyPage.status, 200);
  assert.equal(historyPage.cache, 'no-store');
  assert.equal(historyPage.etag, null);
  const items = listItems(historyPage.body);
  assert.equal(items.length, 1, '识别终态应恰写入一条历史（确定性 event_key ⇒ 不重复）');
  const history = items[0];
  assert.equal(history.kind, 'recognition');
  assert.equal(history.target_ref.type, 'recognition');
  assert.equal(history.target_ref.id, recognitionId);
  assert.equal(history.job_state, 'succeeded');
  assert.equal(Object.hasOwn(history, 'owner_id'), false, '投影不得回 owner_id');
  assert.deepEqual([...Object.keys(history)].sort(), [...HISTORY_KEYS].sort(), '历史投影键集恰等契约');
  assert.equal(history.reference_state, 'unavailable', '无库装配下识别目标核不到 ⇒ 如实 unavailable（不假装可用）');

  // B 的历史列表：看不到 A 的那一条。
  const bHistory = await http(HISTORY, json(sessionB.token));
  assert.equal(bHistory.status, 200);
  assert.deepEqual(listItems(bHistory.body), []);
  assert.equal(bHistory.etag, null);

  // 现行契约**没有** `GET /history/{id}`（只有 delete）⇒ "B 直读 A 的历史详情"无此路径，如实登记。
  const unregistered = await http(`${HISTORY}/${history.id}`, json(sessionB.token));
  assert.equal(unregistered.status, 404, '契约未注册 GET /history/{id} ⇒ 不得悄然出现读详情路径');

  // B 直接拿 A 的**历史 id** 做删除：必须非成功，且与"完全不存在的 id"同形。
  const foreignHistoryDelete = await h.deleteHistory(sessionB.token, history.id, history.revision, 'hist-b');
  const absentHistoryDelete = await h.deleteHistory(sessionB.token, ABSENT_ID, 1, 'hist-b');
  assert.equal(foreignHistoryDelete.status, 404);
  assert.equal(foreignHistoryDelete.body.error.code, 'NOT_FOUND');
  assert.deepEqual(foreignHistoryDelete.body.error, absentHistoryDelete.body.error, '他人历史与不存在必须同形');
  // B 的越权尝试不得动到 A 的行。
  assert.deepEqual(listItems((await http(HISTORY, json(sessionA.token))).body).map((item) => item.id), [history.id]);

  // 可见性从未为 B 核验过 A 的目标：隔离若破（下游把 A 的行当 B 的行投影），这里必然多出 B 的调用。
  assert.deepEqual(
    visibility.calls.filter((call) => call.userId === userB),
    [],
    'B 的读取不得触发对 A 目标的可见性核验',
  );

  note('setup', `A 收藏=${favorite.id}(rev=${favorite.revision}) 识别=${recognitionId} 历史=${history.id}(rev=${history.revision}) 任务=${jobId} 终态=${job.state}`);
  note('case1', `B 列表：收藏=${JSON.stringify(bList.body.data)} 历史=${JSON.stringify(listItems(bHistory.body))}；B 直接拿 A 的收藏/历史 id 发 DELETE ⇒ ${foreignDelete.status}/${foreignHistoryDelete.status} ${foreignDelete.body.error.code}（与"不存在"同形=${JSON.stringify(foreignDelete.body.error) === JSON.stringify(absentDelete.body.error)}；两域均无 {id} 详情读路由，GET 历史详情未注册=${unregistered.status}）`);
  return { favorite, history, recognitionId, jobId };
}

/** ② 删除不可取回：A 删除后 A 再取该 id 必须非成功；B 取同 id 亦非成功。 */
async function testDeleteIsFinal(h, ctx) {
  const { favorite, history, recognitionId, jobId } = ctx;
  const { sessionA, sessionB, http, json } = h;

  const removeFavorite = await h.deleteFavorite(sessionA.token, favorite.id, favorite.revision, 'fav-a-del');
  assert.equal(removeFavorite.status, 200, JSON.stringify(removeFavorite.body));
  assert.deepEqual(removeFavorite.body.data, { accepted: true });
  assert.equal(removeFavorite.cache, 'no-store');

  const ownerSecondDelete = await h.deleteFavorite(sessionA.token, favorite.id, favorite.revision, 'fav-a-del');
  assert.equal(ownerSecondDelete.status, 404, '同一 id 第二次删除必须非成功（不复活、不幂等回放 200）');
  assert.equal(ownerSecondDelete.body.error.code, 'NOT_FOUND');
  const foreignAfterDelete = await h.deleteFavorite(sessionB.token, favorite.id, favorite.revision, 'fav-b-del');
  assert.equal(foreignAfterDelete.status, 404);
  assert.equal(foreignAfterDelete.body.error.code, 'NOT_FOUND');
  assert.deepEqual(foreignAfterDelete.body.error, ownerSecondDelete.body.error);
  assert.deepEqual(listItems((await http(FAVORITES, json(sessionA.token))).body), []);

  // 历史：A 删除该条 ⇒ A/B 再取同 id 皆非成功。
  //
  // ⚠ 行为变更（R33-I16 级联接线，授权 `.pg17/ruling-r33-i16-history-cascade-partial-20261023.md`）：
  // 删除历史行**现在会级联软删它携带的那条识别记录**（契约 `deleteHistory.description` 的要求）。
  // 本臂在此之前断言的是"删除历史不得连带删除识别记录"（那是级联未接线时代的读数），
  // 现按新口径改为：识别记录被**真的软删** ⇒ `GET /recognitions/{id}` 变 404，且与"从未存在"同形；
  // 披露必须是 `partial`（识别腿已删、媒体/外发未接 ⇒ 不可能"全部删成功"）。
  const removeHistory = await h.deleteHistory(sessionA.token, history.id, history.revision, 'hist-a-del');
  assert.equal(removeHistory.status, 202, JSON.stringify(removeHistory.body));
  assert.deepEqual(removeHistory.body.data, { accepted: true });
  assert.equal(removeHistory.body.meta.execution_mode, 'stub');
  assert.equal(
    removeHistory.cascade,
    'partial',
    `X-GY-Cascade=${removeHistory.cascade}：识别腿已删 + 媒体/外发未接 ⇒ partial（unwired 说明接线没装上）`,
  );

  const ownerSecondHistoryDelete = await h.deleteHistory(sessionA.token, history.id, history.revision, 'hist-a-del');
  assert.equal(ownerSecondHistoryDelete.status, 404);
  const foreignHistoryAfterDelete = await h.deleteHistory(sessionB.token, history.id, history.revision, 'hist-b-del');
  assert.equal(foreignHistoryAfterDelete.status, 404);
  assert.deepEqual(foreignHistoryAfterDelete.body.error, ownerSecondHistoryDelete.body.error);
  assert.deepEqual(listItems((await http(HISTORY, json(sessionA.token))).body), []);

  // 级联的两条读数：① 识别记录已软删（404）；② 与"从未存在"逐字同形（软删不泄露存在性）。
  const recognitionAfterDelete = await http(`${RECOGNITIONS}/${recognitionId}`, json(sessionA.token));
  const recognitionNever = await http(`${RECOGNITIONS}/${ABSENT_ID}`, json(sessionA.token));
  assert.equal(recognitionAfterDelete.status, 404, '删除历史必须级联软删对应识别记录（GET 变 404）');
  assert.equal(recognitionAfterDelete.body.error.code, 'NOT_FOUND');
  assert.deepEqual(recognitionAfterDelete.body.error, recognitionNever.body.error, '已软删与从未存在必须同形');
  // 识别终态不因历史被删而重投递（event_key 去重 ⇒ 历史仍为空）。
  assert.deepEqual(listItems((await http(HISTORY, json(sessionA.token))).body), []);
  // B 的越权尝试全程没有改动任何东西。
  assert.deepEqual(listItems((await http(HISTORY, json(sessionB.token))).body), []);
  assert.deepEqual(listItems((await http(FAVORITES, json(sessionB.token))).body), []);

  note('case2', `A 删收藏后 A/B 再取同 id=${ownerSecondDelete.status}/${foreignAfterDelete.status}；A 删历史后 A/B 再取同 id=${ownerSecondHistoryDelete.status}/${foreignHistoryAfterDelete.status}；X-GY-Cascade=${removeHistory.cascade}；历史删除已级联软删识别（GET 识别=${recognitionAfterDelete.status}，与不存在同形） job=${jobId}`);
}

/** ③ 失效/下架不因缓存或旧链接重新公开（逐次重查；含逐账号可见性与 revision 口径）。 */
async function testUnpublishDoesNotRepublish() {
  const h = await fixture();
  const { sessionA, userA, userB, visibility, http, json } = h;
  const a = { type: 'species', id: '00000000-0000-4000-8a00-0000000000c1', revision: 1 };
  const shared = { type: 'herbicide', id: '00000000-0000-4000-8b00-0000000000c2', revision: 1 };
  const scheme = { type: 'scheme', id: '00000000-0000-4000-8c00-0000000000c3', revision: 4 };
  for (const target of [a, shared, scheme]) visibility.publish(target, userA);
  visibility.publish(shared, userB); // 同一对象对 B 也可用

  const mine = (await h.createFavorite(sessionA.token, a, 'fav-unpub')).favorite;
  const sharedOwn = (await h.createFavorite(sessionA.token, shared, 'fav-shared')).favorite;
  const schemeOwn = (await h.createFavorite(sessionA.token, scheme, 'fav-rev')).favorite;
  assert.equal(mine.reference_state, 'available');
  assert.equal(sharedOwn.reference_state, 'available');
  assert.equal(schemeOwn.reference_state, 'available');

  // 下架/失效（同版本从可用集合移除）⇒ **下一次读取**立即变 unavailable，且行仍是同一行（同 id/版本）。
  visibility.unpublish(a, userA);
  const callsBefore = visibility.calls.length;
  const afterUnpublish = await http(FAVORITES, json(sessionA.token));
  const row = itemById(afterUnpublish.body, mine.id);
  assert.equal(row.reference_state, 'unavailable');
  assert.equal(typeof row.unavailable_reason, 'string');
  assert.equal(row.revision, mine.revision, '失效不得改变该行版本（不是"新建一行"）');
  // 反复读取：旧结论（可用）绝不因缓存回来。
  for (let i = 0; i < 3; i += 1) {
    const again = await http(FAVORITES, json(sessionA.token));
    assert.equal(itemById(again.body, mine.id).reference_state, 'unavailable');
  }
  assert.ok(visibility.calls.length >= callsBefore + 4, '每次读取都必须重新派生（不缓存）');

  // 逐账号：A 对该收藏仍可用时，B 读同一对象仍不可用 —— 可用性按账号重查，不是全局缓存。
  visibility.unpublish(shared, userB);
  const aSharedView = itemById((await http(FAVORITES, json(sessionA.token))).body, sharedOwn.id);
  assert.equal(aSharedView.reference_state, 'available', 'A 对同一对象的可用性不得被 B 的读取结果影响');
  assert.equal(aSharedView.unavailable_reason, null);

  // 版本口径：对象以**新版本**重新公开 ⇒ 旧 revision 的收藏**仍不可用**（不得凭新版本复活）。
  visibility.unpublish(scheme, userA);
  visibility.publish({ ...scheme, revision: scheme.revision + 1 }, userA);
  const afterRepublish = itemById((await http(FAVORITES, json(sessionA.token))).body, schemeOwn.id);
  assert.equal(afterRepublish.target_ref.revision, scheme.revision, '收藏指向的版本不得被服务端悄悄改写成新版本');
  assert.equal(afterRepublish.reference_state, 'unavailable', '旧版本引用不得因对象重新公开而复活');
  assert.equal(typeof afterRepublish.unavailable_reason, 'string');
  // 同目标的重复收藏：不新建第二行，且**仍**如实报不可用（收藏动作本身不产生"可用"事实）。
  const refavorited = (await h.createFavorite(sessionA.token, scheme, 'fav-rev')).favorite;
  assert.equal(refavorited.id, schemeOwn.id, '同一目标同一用户只能有一行');
  assert.equal(refavorited.reference_state, 'unavailable');
  assert.equal(listItems((await http(FAVORITES, json(sessionA.token))).body).length, 3);

  // 私有响应一律 no-store ⇒ 没有"缓存副本"可据以重新公开。
  assert.equal((await http(HISTORY, json(sessionA.token))).cache, 'no-store');
  note('case3', `下架后同 id/版本行 reference_state=unavailable（重复读取 3 次仍 unavailable；可见性派生累计 ${visibility.calls.length} 次）；版本 ${scheme.revision}→${scheme.revision + 1} 重新公开后旧收藏仍 unavailable；可用性按账号分别派生（B 对同一对象不可用不影响 A）；列表/详情响应 Cache-Control=no-store`);
}

/** ④ 旧收藏不恢复失效推荐资格（无路径 ⇒ 如实登记在注释与交接，不造假接口）。 */
async function testNoRecommendationRevival() {
  const h = await fixture();
  const { sessionA, userA, visibility, http, json } = h;
  const target = { type: 'species', id: '00000000-0000-4000-8a00-0000000000d1', revision: 2 };
  visibility.publish(target, userA);
  const created = await h.createFavorite(sessionA.token, target, 'fav-elig');
  assert.equal(created.favorite.reference_state, 'available');
  assert.equal(favoriteEligibleForRecommendation(created.favorite), true, '可用对象的收藏本次派生即为合格');

  visibility.unpublish(target, userA);
  const after = itemById((await http(FAVORITES, json(sessionA.token))).body, created.favorite.id);
  assert.equal(after.reference_state, 'unavailable');
  assert.equal(favoriteEligibleForRecommendation(after), false, '失效对象的旧收藏不得恢复推荐资格');
  // 资格只看**本次派生的 reference_state**：投影里没有任何"曾经可用/曾被推荐"的持久痕迹。
  for (const forbidden of ['used', 'usage', 'used_at', 'last_used_at', 'count', 'recommended', 'recommendation_eligible']) {
    assert.equal(Object.hasOwn(after, forbidden), false, `收藏投影不得含 ${forbidden}`);
  }
  assert.equal(favoriteEligibleForRecommendation({ reference_state: 'available' }), true);
  assert.equal(favoriteEligibleForRecommendation({ reference_state: 'unavailable' }), false);

  // 本片**未取得**的判据条款（如实登记，不造路径）：仓库现行**没有**"收藏 ⇒ 推荐资格"的 HTTP 出口
  // 或推荐域调用方（`favoriteEligibleForRecommendation` 只被服务层与单元测试引用，无路由消费）。
  // 因此本脚本只能断言"该行在读取时派生的 reference_state 为 unavailable ⇒ 资格函数为 false"，
  // **不能**声称"推荐结果里不再出现该对象"（无此接口可观测）。详见交接记录 §6。
  note('case4', `失效后 favoriteEligibleForRecommendation(行)=false（行=${after.id}，reference_state=${after.reference_state}，投影无推荐/使用类字段）；无"收藏⇒推荐"HTTP 出口 ⇒ 该判据可观测部分仅此，其余如实登记"未取得"`);
}

async function main() {
  const name = 'favorites-history-isolation-http';
  note('start', `${name}：loopback + stub + 合成身份 + 内存 store（无 PG／无微信工具／无外网／无付费调用）`);
  let h = null;
  try {
    h = await fixture();
    const ctx = await testPrivateIsolation(h);
    await testDeleteIsFinal(h, ctx);
    await testUnpublishDoesNotRepublish();
    await testNoRecommendationRevival();
  } finally {
    // 断言失败也必须关掉**所有**监听中的服务（含用例③/④ 各自的 fixture），
    // 否则事件循环不退出（诚实失败，不挂死）。
    await closeAllFixtures();
  }
  note('done', '全部断言通过：两账号私有隔离、删除不可取回、下架/失效不因缓存或旧链接重新公开、旧收藏不恢复推荐资格');
  console.log(`PASS ${name}; synthetic identities + controllable visibility substitute; real loopback HTTP; no PG, no supplier, no WeChat devtools`);
  // 显式收敛：作业面/内存 store 可能残留定时器，断言结果已定 ⇒ 直接以既定码退出（不挂死、不靠 force）。
  process.exit(process.exitCode ?? 0);
}

try {
  await main();
} catch (error) {
  console.error('[GY-I16-E2E] FAIL 断言失败（原始输出如下，未跳过、未吞错）：');
  console.error(error);
  // 失败路径必须**有界**：先关掉所有监听中的服务（用例③/④ 的 fixture 也在内），
  // 再用 50ms 让已排队的 stdout/stderr 落地（避免 `process.exit` 截断断言文本），
  // 最后以非 0 码确定性退出 —— "红"必须是 ≤1s 的退出码 1，而不是挂到 CI 超时。
  await closeAllFixtures();
  process.exitCode = 1;
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  process.exit(1);
}
