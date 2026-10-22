// GY-I22（#22）· 429 与「同步面 504 PROVIDER_TIMEOUT」的 **HTTP 面** 断言。
//
// 为什么单独补这一片（本片只补断言，不改任何实现）：
//   1. 429：全仓唯一产出点是 `services/api/src/auth/wechat.ts:120-121`（上游 `errcode === 45011`
//      ⇒ `ApiError('RATE_LIMITED', '微信登录请求过于频繁', { retryable: true })`）。此前只有后台 UI
//      对「429 ⇒ rate_limited 映射」的用例（`tests/unit/admin-ui-api.test.mjs:134-137`、`:259`），
//      **服务端自己**回 429 这件事从未被断言过。
//   2. 504：`PROVIDER_TIMEOUT` 目前只在后台 PG 锁通道有 HTTP 用例
//      （`tests/unit/admin-flags-pg.test.mjs:373-391`）；**用户侧同步读面**（`GET /knowledge`）在
//      `57014`（查询取消/超时）与 `55P03`（锁不可用）下折叠成 504 这件事没有 HTTP 面用例。
//      store 层的分类矩阵已有（`tests/unit/db-error-retryable-classification.test.mjs:130-131`），
//      但 store 层通过不等于**线上封套**通过（状态码、头、是否回显驱动文本都在这一层）。
//
// 每个用例都写了「断的是什么行为、为什么它不是实现细节」；共通口径：
//   - **状态码来自契约表**（`services/api/src/contract.ts` 的 `ERROR_STATUS_MAP`：
//     `RATE_LIMITED → 429`、`PROVIDER_TIMEOUT → 504`）。客户端按 `meta` + `error.code` 分派，
//     状态码错了等于契约错了；换一种实现不该动它，所以它是协议而不是实现细节。
//   - **错误封套是客户端唯一可见形状**：`{error:{code,message,retryable,details}, meta:{...}}`。
//     因此断的是键集与逐字段值，而不是某个函数怎么抛。
//   - **本地化文案不得回显驱动/上游原文**：这是数据安全问题（微信 errmsg、SQL 文本、表名、
//     驱动错误串都可能带内部信息），不是文案偏好。
//   - **瞬时失败不得落幂等台账**：429/504 都是「同一请求稍后可能成功」。若被当作结果记进台账，
//     客户端用原键重试会拿到旧结果（409/缓存）而不是真的重连 —— 这是 `retryable: true` 的
//     可观测后果，也是幂等实现必须保证的对外行为。
//
// 本片**不验证**（如实标注，避免把模拟当成实测）：
//   - 微信侧的**真实频率限制**：45011 由上游判定，单进程内无法产生。本文件用**可注入的
//     `fetchImpl`** 在「上游响应」这一层模拟 `errcode: 45011`，所以「连打至限流」这一环是
//     模拟的，不是真实限流；能实测到的是**我方收到 45011 之后的对外行为**（429 + 封套 + 重试语义）。
//   - **`Retry-After` 的「剩余窗口」精确值**：2026-10-22 依 `docs/architecture/state-contract.md:27`
//     补齐了 429 的该头（此前实现不写，本文件当时如实断言「无该头」并登记为口径缺口）。取值规则见
//     `services/api/src/errors.ts` 的 `retryAfterSecondsFor`：本仓当前**没有本地限流器**（全仓唯一
//     429 产出点是 `auth/wechat.ts` 把上游 `errcode 45011` 映射成 `RATE_LIMITED`，上游只给错误码、
//     不给剩余窗口）⇒ 统一给**确定性 1 秒**（openapi 里该头 `minimum: 1`）。本文件能实测的是「头存在、
//     是合法整数秒、且不是 HTTP-date」；**不能**实测真实退避窗口是否够用（那取决于微信的判定策略）。
//   - 504 的 `retryable` 取值：`services/api/src/knowledge/service.ts:119` 用 `ApiError` 缺省值
//     （`false`），与 `services/api/src/errors.ts:31-33` 「瞬时故障应 true」的口径不一致。本文件
//     只断它是布尔（契约类型），把取值差异留给报告，不把可能的缺陷钉成「期望行为」。
//   - 真实数据库：`57014`/`55P03` 由**脚本化桩池**按语句注入（照
//     `tests/unit/knowledge-herbicides-http.test.mjs:42-57` 与 `tests/unit/admin-flags-pg.test.mjs:352-369`
//     的范式），不连真库、不写任何库。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createWechatIdentityProvider } from '../../services/api/src/auth/wechat.ts';
import { statusForErrorCode } from '../../services/api/src/contract.ts';
import { createSubstituteObjectStore } from '../../services/api/src/media/object-store.ts';

const LOGIN_URL = '/api/v1/auth/wechat';
const IDEM = 'idem-key-gy-i22-0001';
/** 上游桩：`errcode: null` 表示上游正常返回 openid，数值表示上游返回该 errcode。 */
const UPSTREAM_ERRMSG = 'synthetic-upstream-throttle-text';

/**
 * 本文件所有应用共用：执行模式固定 stub，只把「身份提供者」和「数据库连接池」换成可注入实现。
 * 这样不依赖真实 AppSecret、不连真实 MySQL/PG，也不改变被测代码的任何分支条件
 * （429 分支要求 provider 走 real 分支，故 429 用例的 provider 用 executionMode:'real' + 注入 fetch）。
 */
function stubConfig() {
  return loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
}

function login(app, { code = 'synthetic-i22-code', key = IDEM } = {}) {
  return app.inject({
    method: 'POST',
    url: LOGIN_URL,
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    payload: { code },
  });
}

// ---------------------------------------------------------------------------------------------
// 429 · 微信登录被上游限流
// ---------------------------------------------------------------------------------------------
test('429：上游 45011 ⇒ HTTP 429 RATE_LIMITED（封套完整 / 带 Retry-After 整数秒 / 失败不落幂等台账）', async (t) => {
  // 断的是行为：
  //   (a) 限流必须以 429 回给客户端，且 `error.code` 是契约里的 RATE_LIMITED；
  //   (b) 封套形状 = 契约（多一个键、少一个键都会破坏客户端分派）；
  //   (c) 本条是「稍后同一请求可能成功」⇒ retryable=true，且**不入幂等台账**：用同一
  //       Idempotency-Key 立刻重试必须真的重打上游，而不是拿到「已完成」的旧结果；
  //   (d) 上游 errmsg 不得出现在响应里。
  // 为什么不是实现细节：这些都是客户端可见的协议面（状态码、键集、可重试语义、错误文案），
  // 换一种限流实现（本地计数 / 网关 / 上游判定）都必须保持，否则客户端要改代码。
  const upstream = { errcode: 45011 };
  const exchanges = [];
  const fetchImpl = async (url, init) => {
    exchanges.push({ url: String(url), method: String(init?.method ?? 'GET') });
    const body = upstream.errcode === null
      ? { openid: 'synthetic-i22-openid', session_key: 'synthetic-i22-session-key' }
      : { errcode: upstream.errcode, errmsg: UPSTREAM_ERRMSG };
    return { ok: true, status: 200, async json() { return body; } };
  };

  const app = buildApp({
    config: stubConfig(),
    wechat: createWechatIdentityProvider({
      // provider 走 real 分支才会真正解析上游 errcode（stub 分支直接合成 subject，不产生 429）。
      executionMode: 'real',
      appId: 'wx-synthetic-i22-appid',
      appSecret: 'synthetic-i22-appsecret',
      lookupKey: 'synthetic-i22-lookup-key',
      fetchImpl,
    }),
  });
  t.after(() => app.close());

  // (a) 状态码不是路由自选，而是契约表决定
  assert.equal(statusForErrorCode('RATE_LIMITED'), 429);

  const first = await login(app);
  assert.equal(first.statusCode, 429, '限流必须回 429（契约表 RATE_LIMITED → 429）');
  const body = first.json();

  // (b) 封套形状：顶层只有 error/meta，error 只有契约四键
  assert.deepEqual(Object.keys(body).sort(), ['error', 'meta']);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'details', 'message', 'retryable']);
  assert.equal(body.error.code, 'RATE_LIMITED');
  assert.equal(body.error.message, '微信登录请求过于频繁');
  assert.equal(body.error.retryable, true, '限流是瞬时失败 ⇒ retryable 必须 true（errors.ts:31-33）');
  assert.deepEqual(body.error.details, [], '限流不是字段级错误，details 必须为空数组');
  assert.equal(body.meta.contract_version, '1.0.0');
  assert.equal(body.meta.execution_mode, 'stub', 'meta 如实反映当前配置模式（本用例只替换了身份提供者）');
  assert.equal(typeof body.meta.request_id, 'string');

  // 驱动层（上游）只被调用一次：429 不是本地重试/多次调用攒出来的
  assert.equal(exchanges.length, 1);
  assert.match(exchanges[0].url, /^https:\/\/api\.weixin\.qq\.com\/sns\/jscode2session\?/);
  assert.match(exchanges[0].url, /js_code=synthetic-i22-code/);

  // (d) 上游 errmsg 不得透出
  assert.equal(JSON.stringify(body).includes(UPSTREAM_ERRMSG), false, '不得回显上游 errmsg');

  // 2026-10-22 依 `docs/architecture/state-contract.md:27`（「429 | RATE_LIMITED / PROVIDER_QUOTA_EXCEEDED |
  // Retry-After」）补齐：429 **必须**带该头。原断言（「无该头」）记录的是补齐前的实现现状，随行为修正
  // 一并改为断「存在且是合法整数秒」——不是删断言，是把口径缺口的断言换成契约要求的断言。
  // 只断可观测契约：头存在、十进制整数、≥1（openapi `minimum: 1`）、不是 HTTP-date。
  const retryAfter = first.headers['retry-after'];
  assert.equal(typeof retryAfter, 'string', '429 必须带 Retry-After（state-contract.md:27）');
  assert.match(retryAfter, /^[1-9][0-9]*$/, `Retry-After 必须是正整数秒（不是 HTTP-date）：${retryAfter}`);
  assert.equal(Number.isInteger(Number(retryAfter)), true);
  assert.equal(Number(retryAfter) >= 1, true, 'openapi 要求 minimum: 1');

  // (c) 瞬时失败不落台账：同键重试必须重新交换，且不得被判成「处理中/冲突」
  const sameKeyRetry = await login(app);
  assert.equal(sameKeyRetry.statusCode, 429);
  assert.equal(exchanges.length, 2, 'produce 失败必须释放占位（routes/support.ts:124-127），同键重试要重新打上游');

  // 限流解除后，同键必须能成功（上一轮的 429 不得把该键钉死为终态）
  upstream.errcode = null;
  const recovered = await login(app);
  assert.equal(recovered.statusCode, 200, '瞬时限流解除后同键应成功，而不是拿到旧的失败/冲突结果');
  assert.equal(typeof recovered.json().data.access_token, 'string');
  assert.equal(exchanges.length, 3);
});

// ---------------------------------------------------------------------------------------------
// 504 · 同步读面把超时族 SQLSTATE 折叠为 PROVIDER_TIMEOUT
// ---------------------------------------------------------------------------------------------

/**
 * 同步读面的脚本化连接池：只回答既有读服务实际发出的那几条 SQL，
 * 并只在指定语句上抛指定 SQLSTATE（不连真库、不落任何数据）。
 * 范式照 `tests/unit/knowledge-herbicides-http.test.mjs:42-57`（按 SQL 文本作答）与
 * `tests/unit/admin-flags-pg.test.mjs:352-369`（connect() → client.query 抛 SQLSTATE → release）。
 */
function scriptedKnowledgePool({ store, sqlState, failOn, leakMarker }) {
  const statements = [];
  const state = { releases: 0 };
  const driverFailure = () => Object.assign(
    new Error(
      `${sqlState}: synthetic driver text (canceling statement due to statement timeout) `
      + `SQL: SELECT * FROM public.users JOIN catalog_read.current_knowledge ON true WHERE id='${leakMarker}'`,
    ),
    { code: sqlState },
  );
  const query = async (text, values) => {
    const sql = String(text);
    statements.push(sql.trim());
    if (sql.includes('FROM public.users')) {
      if (failOn === 'account') throw driverFailure();
      const user = await store.getUser(String(values?.[0] ?? ''));
      return { rows: user ? [{ state: user.state, auth_epoch: user.authEpoch }] : [] };
    }
    if (sql.includes('public.sessions')) {
      if (failOn === 'session') throw driverFailure();
      return { rows: [{ id: 'synthetic-session' }] };
    }
    if (sql.includes('catalog_read.current_knowledge')) {
      if (failOn === 'data') throw driverFailure();
      return { rows: [] };
    }
    return { rows: [] };
  };
  const client = { query, release() { state.releases += 1; } };
  return {
    pool: { async connect() { return client; }, async query() { return { rows: [] }; } },
    statements,
    state,
  };
}

const TIMEOUT_FAMILY = [
  {
    sqlState: '57014',
    failOn: 'data',
    where: '资料读语句（catalog_read.current_knowledge）',
  },
  {
    sqlState: '55P03',
    failOn: 'account',
    where: '会话守卫语句（public.users）',
  },
];

for (const { sqlState, failOn, where } of TIMEOUT_FAMILY) {
  test(`504：同步读面在 ${sqlState} 下折叠为 PROVIDER_TIMEOUT（故障点：${where}）`, async (t) => {
    // 断的是行为：
    //   (a) 同步读面遇到**超时族** SQLSTATE 时必须回 504 + PROVIDER_TIMEOUT，而不是 500/503：
    //       504 是「上游（数据库）超时」，客户端据此区分「稍后重试」与「服务端错误」；
    //   (b) 封套里不得出现 SQL 文本、表名、驱动错误串（数据安全），只留本地化定稿文案；
    //   (c) 失败路径必须回滚事务并释放连接 —— 否则一次超时会挂住连接，后续请求全被拖死；
    //   (d) 本次故障不改变 200 路径的形状（同一 app 实例先登录成功再触发 504）。
    // 为什么不是实现细节：状态码与重试语义是客户端协议；不泄露 SQL 是安全要求；
    // 回滚/释放是资源守恒，崩了就是可用性事故。
    const leakMarker = `gy-i22-sql-leak-marker-${sqlState}`;
    const store = createMemoryAuthStore();
    const scripted = scriptedKnowledgePool({ store, sqlState, failOn, leakMarker });
    const app = buildApp({ config: stubConfig(), store, pool: scripted.pool });
    t.after(() => app.close());

    // 身份来自内存 auth store 的合成登录（不外呼、不伪造微信身份）
    const session = await login(app, { code: `synthetic-i22-${sqlState}` });
    assert.equal(session.statusCode, 200, '合成登录必须先成功，否则下面的 504 不是读面产生的');
    const token = session.json().data.access_token;

    assert.equal(statusForErrorCode('PROVIDER_TIMEOUT'), 504);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/knowledge',
      headers: { authorization: `Bearer ${token}` },
    });

    // (a) 状态码 + 错误码
    assert.equal(response.statusCode, 504, `${sqlState} 必须折叠为 504（契约表 PROVIDER_TIMEOUT → 504）`);
    const body = response.json();
    assert.deepEqual(Object.keys(body).sort(), ['error', 'meta']);
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'details', 'message', 'retryable']);
    assert.equal(body.error.code, 'PROVIDER_TIMEOUT');
    assert.equal(body.error.message, '资料数据库暂不可用', '只用本地化定稿文案');
    // 契约类型是布尔。**实测当前取值为 false**（`knowledge/service.ts:119` 用 `ApiError` 缺省值），
    // 与 `errors.ts:31-33`「瞬时故障应 retryable:true」的口径不一致 —— 这是口径缺口，见文件头
    // 「本片不验证」第 3 条：本片只补断言、不改行为，故只钉类型，不把疑似缺陷钉成期望值。
    assert.equal(typeof body.error.retryable, 'boolean');
    assert.deepEqual(body.error.details, []);
    assert.equal(body.meta.contract_version, '1.0.0');

    // 失败响应同样不可缓存（onSend：状态码 ≥ 400 ⇒ no-store，见 app.ts:737-743）
    assert.equal(response.headers['cache-control'], 'no-store');

    // (b) 不泄露：SQL 文本 / 表名 / 驱动错误串都不许出现在线上封套里
    const wire = JSON.stringify(body);
    for (const forbidden of [leakMarker, 'catalog_read', 'public.users', 'SELECT', 'statement timeout']) {
      assert.equal(wire.includes(forbidden), false, `封套不得回显驱动错误文本：${forbidden}`);
    }

    // (c) 失败路径收尾：事务回滚 + 连接释放
    assert.equal(scripted.statements.some((s) => /^BEGIN$/i.test(s)), true, '读面必须开事务（守卫语句与数据语句同一快照）');
    assert.equal(scripted.statements.some((s) => /^ROLLBACK$/i.test(s)), true, '超时必须回滚，不能留下悬挂事务');
    assert.equal(scripted.state.releases, 1, '连接必须释放一次（finally 分支）');
  });
}

// ---------------------------------------------------------------------------------------------
// 409 · REQUEST_IN_PROGRESS（真实域：媒体同键并发）是否真的带 Retry-After
// ---------------------------------------------------------------------------------------------
// 为什么要单独钉这一条：`services/api/src/media/service.ts:778` 的注释声称「仍在处理中 ⇒ 409
// `REQUEST_IN_PROGRESS`（`app.ts` 会附带 `Retry-After: 1`）」。注释与实现之间最常见的偏差就是
// 「注释说有、实现没写」，而缺头比注释撒谎轻——所以这里用**真实 HTTP 409** 把注释钉住：不注入
// 任何错误桩路由，走媒体受理面自己的同键保护（`withKeyClaim` 在第一个 await 之前同步登记占位）。
test('409：媒体域同键并发 ⇒ REQUEST_IN_PROGRESS 带 Retry-After: 1（钉住 media/service.ts:778 注释）', async (t) => {
  // 断的是行为：契约 `docs/architecture/state-contract.md:34`「处理中 409 `REQUEST_IN_PROGRESS`
  // 带 Retry-After」。客户端据此知道「等几秒再用同一个 Idempotency-Key 重试」，所以它是协议面。
  const baseStore = createSubstituteObjectStore();
  const originalPresign = baseStore.presignUpload.bind(baseStore);
  // 让**首个**请求停在对象存储预签（`initiateUploadUnclaimed` 的第一个 await），从而确定性地让
  // 第二个同键请求撞上占位；不靠定时器竞猜，也不依赖「先完成再回放」的时序巧合。
  let enteredPresign;
  const entered = new Promise((resolve) => { enteredPresign = resolve; });
  let releasePresign;
  const holding = new Promise((resolve) => { releasePresign = resolve; });
  const gatedStore = {
    ...baseStore,
    presignUpload: (input) => {
      enteredPresign();
      return holding.then(() => originalPresign(input));
    },
  };

  const app = buildApp({ config: stubConfig(), mediaObjectStore: gatedStore });
  t.after(() => app.close());

  const session = await login(app, { code: 'synthetic-i22-409', key: 'idem-key-gy-i22-409-login' });
  assert.equal(session.statusCode, 200, '合成登录必须先成功，否则下面的 409 不是媒体受理面产生的');
  const token = session.json().data.access_token;

  const payload = { purpose: 'label_ocr', mime: 'image/png', bytes: 10, sha256: 'a'.repeat(64) };
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'idempotency-key': 'idem-key-gy-i22-409-media',
  };

  const firstPromise = app.inject({ method: 'POST', url: '/api/v1/media/uploads', headers, payload });
  const guard = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error('首个请求未进入对象存储预签（媒体受理面结构可能已变，本用例需重新校准）')),
      5000,
    );
    timer.unref?.();
  });
  await Promise.race([entered, guard]);

  const second = await app.inject({ method: 'POST', url: '/api/v1/media/uploads', headers, payload });
  assert.equal(second.statusCode, 409, `同键并发必须回 409：${second.body}`);
  const conflict = second.json();
  assert.equal(conflict.error.code, 'REQUEST_IN_PROGRESS');
  assert.equal(conflict.error.retryable, true, '等待后重试同一请求可成功 ⇒ retryable 必须 true');

  // 注释声称的 `Retry-After: 1`：存在、整数秒、且不是 HTTP-date
  assert.equal(second.headers['retry-after'], '1', 'media/service.ts:778 注释声称 409 带 Retry-After: 1');
  assert.match(String(second.headers['retry-after']), /^[1-9][0-9]*$/);
  assert.equal(conflict.meta.contract_version, '1.0.0');

  // 放行首个请求：占位释放后同键重试必须能正常受理（不是永久 409）
  releasePresign();
  const first = await firstPromise;
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.headers['retry-after'], undefined, '201 不是「稍后再试」，不得带等待头');

  const replay = await app.inject({ method: 'POST', url: '/api/v1/media/uploads', headers, payload });
  assert.equal(replay.statusCode, 201, '占位释放后同键请求应按幂等回放受理');
  assert.equal(replay.headers['retry-after'], undefined, '回放不是「稍后再试」，不得带等待头');
});
