/**
 * GY-R68 · 合成模式的**固定测试身份**（`WECHAT_STUB_SUBJECT`）
 *
 * 缺口（本片要证的事）：`services/api/src/auth/wechat.ts` 的合成分支把 `wx.login` 的 code 派生为
 * subject，而每次登录 code 都不同 ⇒ 开发者工具里点一次登录就是一个**新账号**，资料/收藏在两次
 * 登录之间不互通 ⇒「退出 → 用同一身份重登 → 数据仍在」这条 P0 恢复链路在 stub 下**证不了**
 * （real 模式需要真凭据，本机没有）。
 *
 * 本文件分三层：
 *   ① 配置面：`WECHAT_STUB_SUBJECT` 在 stub／preset_demo 下非空才生效；未设/空白回落（默认不变）；
 *      **real 模式下设了也是 `null`**；超长/控制字符报 `INVALID_VALUE`（不静默退回 code 派生）。
 *   ② 身份派生：同一固定串 + 两个不同 code ⇒ **同一个** subjectLookup；不设变量 ⇒ 两个 code
 *      **不同** subject（负控制，证明默认行为没被改）；real 分支不读该字段（身份仍来自 openid）。
 *   ③ 链路（HTTP，真装配 `buildApp` + 内存 store）：登录 → 收藏 → 退出 → **换一个 code 重登** →
 *      `GET /favorites` 仍是同一条、属主不变；不设变量时同一流程**看不到**那条（负控制）。
 *      安全边界同样在 HTTP 面钉住：请求体多余字段 400，查询参数/header 里的「自称 subject」
 *      对结果**没有影响**。
 *
 * 证据级别（如实）：③ 是**替身级**（stub 合成身份 + 进程内内存 store，不连 PostgreSQL，
 * 不验真实微信凭据/真实库持久化）。它证明的是「API 层 + 合成身份派生」这条链，
 * **不是**真库级证据，也不构成真实登录验收。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { ConfigError, loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import {
  STUB_APP_ID,
  STUB_LOOKUP_KEY,
  STUB_OPENID_PREFIX,
  STUB_SUBJECT_OPENID_PREFIX,
  computeSubjectLookup,
  createWechatIdentityProvider,
} from '../../services/api/src/auth/wechat.ts';

const FIXED = 'qa-dev-1';
const FIXED_SUBJECT = `${STUB_SUBJECT_OPENID_PREFIX}${FIXED}`;

const REAL_ENV = Object.freeze({
  APP_EXECUTION_MODE: 'real',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/gengyun',
  SESSION_SIGNING_KEY: 'x'.repeat(32),
  DELETION_LEDGER_KEY: 'y'.repeat(32),
  WECHAT_APP_ID: 'wx0000000000000000',
  WECHAT_APP_SECRET: 'secret',
  OBJECT_STORAGE_ENDPOINT: 'https://oss.example.invalid',
  OBJECT_STORAGE_BUCKET: 'gengyun',
  OBJECT_STORAGE_ACCESS_KEY: 'ak',
  OBJECT_STORAGE_SECRET_KEY: 'sk',
});

function stubConfig(extra = {}) {
  return loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', ...extra });
}

/** 合成身份提供者（非 real ⇒ 走合成分支）；默认不设固定身份。 */
function stubProvider(extra = {}) {
  return createWechatIdentityProvider({
    executionMode: 'stub',
    appId: null,
    appSecret: null,
    lookupKey: STUB_LOOKUP_KEY,
    ...extra,
  });
}

function subjectOf(openid) {
  return computeSubjectLookup(STUB_LOOKUP_KEY, STUB_APP_ID, openid);
}

// ---------------------------------------------------------------------------
// ① 配置面
// ---------------------------------------------------------------------------

test('配置：stub 下 WECHAT_STUB_SUBJECT 非空生效（前后空白按去空白后的值）', () => {
  assert.equal(stubConfig({ WECHAT_STUB_SUBJECT: FIXED }).wechatStubSubject, FIXED);
  assert.equal(stubConfig({ WECHAT_STUB_SUBJECT: `  ${FIXED}  ` }).wechatStubSubject, FIXED);
});

test('配置：未设/空串/纯空白 ⇒ null（默认行为逐字不变，不新增必填项）', () => {
  assert.equal(stubConfig().wechatStubSubject, null);
  assert.equal(stubConfig({ WECHAT_STUB_SUBJECT: '' }).wechatStubSubject, null);
  assert.equal(stubConfig({ WECHAT_STUB_SUBJECT: '   ' }).wechatStubSubject, null);
});

test('配置：real 模式下该变量完全不生效（设了也是 null，且不因此报配置错）', () => {
  const config = loadConfig({ ...REAL_ENV, WECHAT_STUB_SUBJECT: FIXED });
  assert.equal(config.executionMode, 'real');
  assert.equal(config.wechatStubSubject, null);
});

test('配置：preset_demo（另一种合成模式）同样生效 —— 判据是「非 real」，与合成身份分支同源', () => {
  const config = loadConfig({ APP_EXECUTION_MODE: 'preset_demo', LOG_LEVEL: 'silent', WECHAT_STUB_SUBJECT: FIXED });
  assert.equal(config.executionMode, 'preset_demo');
  assert.equal(config.wechatStubSubject, FIXED);
});

test('配置：超长或含控制字符 ⇒ INVALID_VALUE（不静默退回按 code 派生）', () => {
  for (const bad of ['x'.repeat(129), 'qa\ndev', 'qa\u0000dev']) {
    assert.throws(
      () => stubConfig({ WECHAT_STUB_SUBJECT: bad }),
      (error) => {
        assert.ok(error instanceof ConfigError);
        const issue = error.issues.find((item) => item.field === 'WECHAT_STUB_SUBJECT');
        assert.ok(issue, `应报 WECHAT_STUB_SUBJECT 的配置问题，实际：${JSON.stringify(error.issues)}`);
        assert.equal(issue.code, 'INVALID_VALUE');
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// ② 身份派生（含负控制与 real 边界）
// ---------------------------------------------------------------------------

test('合成身份：同一固定串 + 两个不同 code ⇒ 同一个 subjectLookup（同一用户）', async () => {
  const provider = stubProvider({ stubSubject: FIXED });
  const first = await provider.exchange('code-first');
  const second = await provider.exchange('code-second');
  assert.equal(first.subjectLookupHex, second.subjectLookupHex);
  // 固定身份的命名空间与按 code 派生的 `stub:` 不相交
  assert.equal(first.subjectLookupHex, subjectOf(FIXED_SUBJECT));
  assert.notEqual(first.subjectLookupHex, subjectOf(`${STUB_OPENID_PREFIX}code-first`));
});

test('负控制：不设变量 ⇒ 两个 code 得到不同 subject，且摘要与接线前逐字一致', async () => {
  const provider = stubProvider();
  const first = await provider.exchange('code-first');
  const second = await provider.exchange('code-second');
  assert.notEqual(first.subjectLookupHex, second.subjectLookupHex, '默认必须仍是「一次登录一个新用户」');
  assert.equal(first.subjectLookupHex, subjectOf(`${STUB_OPENID_PREFIX}code-first`));
  assert.equal(second.subjectLookupHex, subjectOf(`${STUB_OPENID_PREFIX}code-second`));
});

test('负控制：空串/纯空白 stubSubject 等同未设（回落 code 派生，不受装配层手误影响）', async () => {
  for (const empty of ['', '   ', null, undefined]) {
    const provider = stubProvider({ stubSubject: empty });
    const first = await provider.exchange('code-first');
    assert.equal(first.subjectLookupHex, subjectOf(`${STUB_OPENID_PREFIX}code-first`));
  }
});

test('real 模式：设了 stubSubject 也不生效 —— 无凭据仍 fail-closed；有凭据只用 openid', async () => {
  // ① 无凭据：仍按接线前报 PROVIDER_UNAVAILABLE，绝不拿 stubSubject 合成一个身份
  const unwired = createWechatIdentityProvider({
    executionMode: 'real',
    appId: null,
    appSecret: null,
    lookupKey: STUB_LOOKUP_KEY,
    stubSubject: FIXED,
  });
  await assert.rejects(
    () => unwired.exchange('code-first'),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
  );

  // ② 有凭据：摘要只由 sns/jscode2session 返回的 openid 决定，与 stubSubject 无关
  const urls = [];
  const wired = createWechatIdentityProvider({
    executionMode: 'real',
    appId: 'wx-test-app',
    appSecret: 'test-secret',
    lookupKey: STUB_LOOKUP_KEY,
    stubSubject: FIXED,
    fetchImpl: async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ openid: 'wx-openid-from-wechat' }) };
    },
  });
  const result = await wired.exchange('code-first');
  assert.equal(urls.length, 1, 'real 分支必须真的去换 openid（没有走合成捷径）');
  assert.equal(result.subjectLookupHex, computeSubjectLookup(STUB_LOOKUP_KEY, 'wx-test-app', 'wx-openid-from-wechat'));
  assert.notEqual(result.subjectLookupHex, subjectOf(FIXED_SUBJECT));
});

// ---------------------------------------------------------------------------
// ③ 链路（HTTP，真装配；替身级证据）
// ---------------------------------------------------------------------------

const LOGIN_URL = '/api/v1/auth/wechat';
const LOGOUT_URL = '/api/v1/auth/logout';
const FAVORITES_URL = '/api/v1/favorites';

/** 真装配一个 stub 应用（内存 store；可带/不带固定测试身份）。 */
async function httpFixture(t, extraEnv = {}) {
  const config = stubConfig(extraEnv);
  const store = createMemoryAuthStore();
  const app = buildApp({ config, store });
  t.after(() => app.close());

  const requests = [];
  async function call(method, url, { token, payload, headers = {} } = {}) {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(payload === undefined ? {} : { payload }),
    });
    requests.push(`${method} ${url} → ${response.statusCode}`);
    let body = null;
    try {
      body = response.json();
    } catch {
      body = null;
    }
    return { status: response.statusCode, body };
  }

  async function login(code, key) {
    return call('POST', LOGIN_URL, { payload: { code }, headers: { 'idempotency-key': key } });
  }

  return { config, store, call, login, requests };
}

const FAVORITE_BODY = { target_ref: { type: 'species', id: 'spc-1', revision: 1 } };

test('链路：设了固定身份 ⇒ 退出后用**另一个 code** 重登，收藏仍是同一条、属主不变', async (t) => {
  const h = await httpFixture(t, { WECHAT_STUB_SUBJECT: FIXED });

  // 1) 第一次登录（code-1）
  const first = await h.login('wx-code-1', 'login-key-0001');
  assert.equal(first.status, 200);
  const tokenA = first.body.data.access_token;
  assert.equal(first.body.meta.execution_mode, 'stub');

  // 2) 收藏一条
  const created = await h.call('POST', FAVORITES_URL, {
    token: tokenA,
    payload: FAVORITE_BODY,
    headers: { 'idempotency-key': 'fav-create-0001' },
  });
  assert.equal(created.status, 201);
  const favoriteId = created.body.data.id;

  // 3) 退出：同一个令牌立刻失效
  const logout = await h.call('POST', LOGOUT_URL, { token: tokenA, headers: { 'idempotency-key': 'logout-key-0001' } });
  assert.equal(logout.status, 200);
  assert.equal(logout.body.data.accepted, true);
  const afterLogout = await h.call('GET', FAVORITES_URL, { token: tokenA });
  assert.equal(afterLogout.status, 401);
  assert.equal(afterLogout.body.error.code, 'SESSION_EXPIRED');

  // 4) **换一个 code 重登**（真机上每次 wx.login 都是新 code）——这就是本片要证的那一步
  const second = await h.login('wx-code-2', 'login-key-0002');
  assert.equal(second.status, 200);
  const tokenB = second.body.data.access_token;
  assert.notEqual(tokenB, tokenA, '重登必须签发新会话令牌（不是复用旧令牌）');

  // 5) 数据仍在：同一条收藏、属主没变（列表按属主过滤 ⇒ 能读到即同一属主）
  const listed = await h.call('GET', FAVORITES_URL, { token: tokenB });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.items.length, 1, `重登后收藏条数应仍为 1，实际 ${listed.body.data.items.length}`);
  assert.equal(listed.body.data.items[0].id, favoriteId);
  assert.equal(listed.body.data.items[0].target_ref.id, FAVORITE_BODY.target_ref.id);

  // 6) 属主不变的服务端证据：两次登录落到**同一行用户**（合成身份由固定串派生）
  const owner = await h.store.findUserBySubject(subjectOf(FIXED_SUBJECT));
  assert.ok(owner, '固定身份应对应一行用户');
  assert.equal(owner.state, 'active');
  // 并且 code 不再派生第二个用户（否则「重登恢复」只是巧合读到了同一批数据的另一行）
  assert.equal(
    await h.store.findUserBySubject(subjectOf(`${STUB_OPENID_PREFIX}wx-code-2`)),
    null,
    '固定身份生效时，第二个 code 不应派生出一个新用户',
  );

  // 7) 另一个（**另一个 subject 的**）用户读不到、也删不掉这条：属主边界没被放开
  //    注：固定身份生效时「换 code」仍是同一用户（这正是本片的目的），所以这里直接铸一个
  //    摘要不同的用户与会话，才能真的扮演「别人」。
  const stranger = await h.store.createUser('f'.repeat(64));
  const strangerToken = 'synthetic-stranger-token-0001';
  await h.store.createSession({
    userId: stranger.id,
    tokenHashHex: hashToken(strangerToken),
    authEpoch: stranger.authEpoch,
    expiresAt: new Date(Date.now() + 3600_000),
    audience: 'user',
  });
  const strangerList = await h.call('GET', FAVORITES_URL, { token: strangerToken });
  assert.equal(strangerList.status, 200);
  assert.deepEqual(strangerList.body.data.items, []);
  const strangerDelete = await h.call('DELETE', `${FAVORITES_URL}/${favoriteId}`, {
    // 与真机 `wx.request` 同形：无请求体也带 JSON content-type（见 `favorites-http.test.mjs` 的说明）。
    token: strangerToken,
    headers: { 'content-type': 'application/json', 'idempotency-key': 'fav-delete-stranger-0001', 'if-match': '"1"' },
  });
  assert.equal(strangerDelete.status, 404, '越权删必须同形 404（不泄露存在性）');

  t.diagnostic(
    `同 subject 两次登录：login#1(code-1) → 收藏 ${favoriteId} → 退出(401 SESSION_EXPIRED) → `
    + `login#2(code-2) → GET /favorites 仍 ${listed.body.data.items.length} 条，id 一致，属主 ${owner.id.slice(0, 8)}…`,
  );
});

test('负控制（链路）：不设变量 ⇒ 同一流程换 code 重登就看不到那条收藏（默认仍是「一次登录一个用户」）', async (t) => {
  const h = await httpFixture(t);

  const first = await h.login('wx-code-1', 'login-key-0001');
  assert.equal(first.status, 200);
  const tokenA = first.body.data.access_token;
  const created = await h.call('POST', FAVORITES_URL, {
    token: tokenA,
    payload: FAVORITE_BODY,
    headers: { 'idempotency-key': 'fav-create-0001' },
  });
  assert.equal(created.status, 201);
  await h.call('POST', LOGOUT_URL, { token: tokenA, headers: { 'idempotency-key': 'logout-key-0001' } });

  const second = await h.login('wx-code-2', 'login-key-0002');
  assert.equal(second.status, 200);
  const listed = await h.call('GET', FAVORITES_URL, { token: second.body.data.access_token });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data.items, [], '不设变量时两次登录必须是**不同**用户（默认行为未变）');

  // 两个 code 对应两行不同用户（直接看库侧合成摘要）
  const userA = await h.store.findUserBySubject(subjectOf(`${STUB_OPENID_PREFIX}wx-code-1`));
  const userB = await h.store.findUserBySubject(subjectOf(`${STUB_OPENID_PREFIX}wx-code-2`));
  assert.ok(userA && userB);
  assert.notEqual(userA.id, userB.id);

  t.diagnostic(
    `负控制：未设 WECHAT_STUB_SUBJECT ⇒ code-1 与 code-2 是两行用户（${userA.id.slice(0, 8)}… ≠ ${userB.id.slice(0, 8)}…），`
    + `重登后 GET /favorites = ${listed.body.data.items.length} 条`,
  );
});

test('安全边界（HTTP）：请求体多余字段 400；查询参数/header 自称 subject 一律不影响身份', async (t) => {
  const h = await httpFixture(t, { WECHAT_STUB_SUBJECT: FIXED });

  // ① 请求体里塞 subject/openid/user_id ⇒ schema additionalProperties:false ⇒ 400，且不建任何用户
  for (const extra of [{ subject: 'evil' }, { openid: 'evil' }, { user_id: 'evil' }, { stub_subject: 'evil' }]) {
    const injected = await h.call('POST', LOGIN_URL, {
      payload: { code: 'wx-code-1', ...extra },
      headers: { 'idempotency-key': `login-evil-${Object.keys(extra)[0]}` },
    });
    assert.equal(injected.status, 400, `请求体多余字段 ${JSON.stringify(extra)} 必须 400`);
    assert.equal(injected.body.error.code, 'INVALID_REQUEST');
  }
  assert.equal(await h.store.findUserBySubject(computeSubjectLookup(STUB_LOOKUP_KEY, STUB_APP_ID, 'evil')), null);

  // ② 查询参数与 header 里的「自称 subject」不参与派生：拿到的仍是固定身份那个用户
  const baseline = await h.login('wx-code-1', 'login-key-0001');
  assert.equal(baseline.status, 200);
  const baselineToken = baseline.body.data.access_token;
  const created = await h.call('POST', FAVORITES_URL, {
    token: baselineToken,
    payload: FAVORITE_BODY,
    headers: { 'idempotency-key': 'fav-create-0001' },
  });
  assert.equal(created.status, 201);

  const spoofed = await h.call('POST', `${LOGIN_URL}?subject=evil&openid=evil&code=evil`, {
    payload: { code: 'wx-code-2' },
    headers: {
      'idempotency-key': 'login-key-0002',
      'x-wechat-subject': 'evil',
      'x-openid': 'evil',
      'x-user-id': 'evil',
    },
  });
  assert.equal(spoofed.status, 200);
  const spoofedToken = spoofed.body.data.access_token;
  const listed = await h.call('GET', FAVORITES_URL, { token: spoofedToken });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.items.length, 1, '查询/header 自称的 subject 不得把身份分叉出去');
  assert.equal(listed.body.data.items[0].id, created.body.data.id);

  // ③ 反向：伪造的 subject 没有在库里落成用户
  assert.equal(await h.store.findUserBySubject(computeSubjectLookup(STUB_LOOKUP_KEY, STUB_APP_ID, 'evil')), null);
  assert.equal(await h.store.findUserBySubject(subjectOf('evil')), null);
});
