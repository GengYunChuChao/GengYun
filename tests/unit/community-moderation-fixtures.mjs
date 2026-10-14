/**
 * GY-I14（#14 审核域）⇄ GY-I15（#15 社区域）· **联动接线测试夹具**（**不是测试文件**）。
 *
 * 复用背景（不另起一套）：
 *   - 社区侧的账号/正文/规则夹具复用 `tests/unit/community-fixtures.mjs`；
 *   - 合成模型端口复用 `tests/moderation/_model-fixtures.mjs`（GY-I14 自己的那份）；
 *   - 装配走**真实的** `buildApp`（不是自建替身装配），这样"接线点"才是被验证的对象。
 *
 * 声明（不得误读）：
 *   - 这里的模型端口是**合成替身**（`provider.synthetic === true`）：只证明**接线与判定口径**，
 *     **不是**真实 `tms`/`ims` 供应商的调用证据，也不构成审核准确率/召回率证据；
 *   - 本文件与所有用例**不发起任何真实模型/付费调用**，端口 `evaluate` 全为纯函数。
 */
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createLocalPseudonymousAuthorDirectory } from '../../services/api/src/community/authors.ts';
import { createCommunityModerationLink } from '../../services/api/src/community/moderation-link.ts';
import { createCommunityContentAuthority } from '../../services/api/src/community/moderation-authority.ts';
import { createCommunityService } from '../../services/api/src/community/service.ts';
import { createModerationService } from '../../services/api/src/moderation/service.ts';
import { CLEAN_BODY, CLEAN_TITLE, USER_A, USER_B, idem, makeGate, makeIdFactory } from './community-fixtures.mjs';
import { blockVerdict, makePort, passVerdict } from '../moderation/_model-fixtures.mjs';

export { CLEAN_BODY, CLEAN_TITLE, USER_A, USER_B, idem, makeGate };

export const API = '/api/v1';
export const START = Date.UTC(2026, 9, 20, 4, 0, 0);
/** 合成投稿/评论正文（不含任何规则命中形态）。 */
export const SAFE_TITLE = CLEAN_TITLE;
export const SAFE_BODY = CLEAN_BODY;
export const OTHER_SAFE_BODY = '今年雨水偏多，我按标签说明轮换用药，并记录了施药日期。';

// ---------------------------------------------------------------------------
// 合成模型端口（**替身**，不联网、不读环境变量、无凭据）
// ---------------------------------------------------------------------------

/** 一律回报 `pass` 的合成文本端口（⇒ 审核域得 `approved`）。 */
export function passingPort(overrides = {}) {
  return makePort({ kind: 'tms', ...overrides });
}

/** 一律回报 `block` 的合成文本端口（⇒ 审核域**明确驳回**，`hard_rule_passed === true` 的模型层驳回）。 */
export function blockingPort(overrides = {}) {
  return makePort({ kind: 'tms', evaluate: () => blockVerdict(), ...overrides });
}

/** 一律回报 `unsure`（无结论）的合成文本端口。 */
export function unsurePort(overrides = {}) {
  return makePort({
    kind: 'tms',
    evaluate: () => ({ label: 'unsure', reason_codes: ['SYNTHETIC_NO_CONCLUSION'], summary: 'synthetic unsure' }),
    ...overrides,
  });
}

/**
 * 按**正文关键词**决定的合成端口：`text.includes(block_marker)` ⇒ `block`，否则 `pass`。
 * 用来在**同一条装配**里同时跑"通过"与"驳回"两条路径（不靠改环境）。
 */
export function markerPort({ blockMarker }) {
  const requests = [];
  const port = makePort({
    kind: 'tms',
    evaluate: (request) => {
      requests.push(request);
      const text = typeof request?.content?.text === 'string' ? request.content.text : '';
      return text.includes(blockMarker) ? blockVerdict() : passVerdict();
    },
  });
  return { port, requests };
}

/**
 * 按**目标 revision**决定的合成端口：`revision >= block_from` ⇒ `block`，否则 `pass`。
 * 用来证明"审核域按版本级绑定判定"（新版本不吃旧版本的结论）。
 */
export function revisionGatedPort({ blockFrom = 2 } = {}) {
  const requests = [];
  const port = makePort({
    kind: 'tms',
    evaluate: (request) => {
      requests.push(request);
      const revision = request?.target_ref?.revision;
      return typeof revision === 'number' && revision >= blockFrom ? blockVerdict() : passVerdict();
    },
  });
  return { port, requests };
}

/** 记录每次 `evaluate` 入参的包装（用于断言"规则先挡 ⇒ 零模型外发"）。 */
export function countingPort(port) {
  const requests = [];
  return {
    requests,
    port: {
      ...port,
      evaluate: (request) => {
        requests.push(request);
        return port.evaluate(request);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 可观察的联动端口（**只观察，不改变行为**：全部调用原样委托给真实端口）
// ---------------------------------------------------------------------------

export function observeLink(inner) {
  const calls = { screen: [], withdraw: [], readView: [], conclusionFor: [] };
  const link = {
    wired: inner.wired,
    get note() {
      return inner.note;
    },
    async screen(input) {
      const result = await inner.screen(input);
      calls.screen.push({ input, result });
      return result;
    },
    async withdraw(input) {
      const result = await inner.withdraw(input);
      calls.withdraw.push({ input, result });
      return result;
    },
    async readView(input) {
      const result = await inner.readView(input);
      calls.readView.push({ input, result });
      return result;
    },
    conclusionFor(target) {
      const result = inner.conclusionFor(target);
      calls.conclusionFor.push({ target, result });
      return result;
    },
    counts: () => inner.counts(),
  };
  return { link, calls };
}

// ---------------------------------------------------------------------------
// 装配级 harness（真实 `buildApp`）
// ---------------------------------------------------------------------------

/**
 * 建一套**已装配**的应用（`buildApp`）。
 *
 * `options`：
 *   - `executionMode`：`stub`（默认）/ `real`（整域 fail-closed，用于反例）；
 *   - `ports`：合成模型端口注入（`real` 下会被审核域忽略，这正是被断言的口径）；
 *   - `authority`：替换审核域的**内容权威端口**（用于"同源/不同源"对照）；
 *   - `service`：注入已建好的审核域实例（与 `communityModeration` 配合可观察联动入参/出参）；
 *   - `communityModeration`：替换社区侧的联动端口（`null` = 显式关闭联动）；
 *   - `wireModeration({ store, authors, executionMode })`：**钩子**，让调用方拿到与本次装配
 *     **同一份** `CommunityStore`/`AuthorDirectory` 去自建审核域与联动端口（见 `makeWiredHarness`）；
 *     返回 `{ service, communityModeration }` 时优先使用；
 *   - `store`/`gate`/`authors`/`messages`：复用既有夹具。
 */
export function makeHarness(options = {}) {
  let time = options.startTime ?? START;
  const auth = options.auth ?? createMemoryAuthStore();
  const store = options.store ?? createMemoryCommunityStore({ now: () => time });
  const authors = options.authors ?? createLocalPseudonymousAuthorDirectory();
  const messages = options.messages ?? createMemoryMessagesStore({ now: () => time });
  const executionMode = options.executionMode ?? 'stub';
  const config = {
    // 与既有社区/媒体夹具同口径：先按 stub 载入（不读真实环境变量、不落真凭据），
    // 再显式覆盖为 `real`（用于 fail-closed 反例）。
    ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    ...(executionMode === 'real' ? { executionMode: 'real', requiresRealCredentials: true } : {}),
  };
  const wired =
    typeof options.wireModeration === 'function' ? options.wireModeration({ store, authors, executionMode }) : null;
  const injectedService = wired?.service ?? options.service;
  const communityModeration = wired?.communityModeration ?? options.communityModeration;
  const app = buildApp({
    config,
    store: auth,
    now: () => new Date(time),
    communityInjection: {
      store,
      authors,
      gate: options.gate ?? makeGate(),
      ...(communityModeration === undefined ? {} : { moderation: communityModeration }),
    },
    messagesInjection: { store: messages },
    moderationInjection: {
      ...(injectedService === undefined ? {} : { service: injectedService }),
      ...(options.ports === undefined ? {} : { ports: options.ports }),
      ...(options.authority === undefined ? {} : { authority: options.authority }),
    },
  });
  return {
    app,
    auth,
    store,
    messages,
    service: app.communityService,
    moderation: app.moderationService,
    link: app.communityModerationLink,
    get time() {
      return time;
    },
    advance: (ms) => {
      time += ms;
    },
    inject: (method, path, request = {}) => inject(app, method, path, request),
    /** 建一个**真实会话**（用于 HTTP 断言；凭据是合成值，不入库、不入日志）。 */
    async session(subject, audience = 'user') {
      const created = await auth.createUser(String(subject).repeat(64));
      const token = `synthetic-i14i15-token-${subject}`;
      await auth.createSession({
        userId: created.id,
        tokenHashHex: hashToken(token),
        authEpoch: created.authEpoch,
        expiresAt: new Date(START + 48 * 3600_000),
        audience: 'user',
      });
      return { userId: created.id, token, actor: { userId: created.id, role: 'user', authEpoch: created.authEpoch } };
    },
    async adminSession(scopes = ['sources:write', 'audit:read']) {
      const userId = await auth.createAdmin({
        loginName: `i14i15-admin-${Math.random().toString(36).slice(2, 8)}`,
        credentialHash: 'synthetic-not-a-real-credential-hash',
        scopes,
      });
      const token = `synthetic-i14i15-admin-token-${userId.slice(0, 8)}`;
      await auth.createSession({
        userId,
        tokenHashHex: hashToken(token),
        authEpoch: 1,
        expiresAt: new Date(START + 3600_000),
        audience: 'admin',
      });
      return { userId, token, adminCtx: adminCtx(userId, scopes) };
    },
  };
}

/** 后台调用上下文（与路由强制注入的身份同形；客户端不可自述）。 */
export function adminCtx(userId, scopes = ['sources:write', 'audit:read'], overrides = {}) {
  return {
    identity: { userId, authEpoch: 1, role: 'admin', scopes: [...scopes] },
    idempotencyKey: `gy-i14i15-admin-${Math.random().toString(36).slice(2, 12)}`,
    ...overrides,
  };
}

/** HTTP 注入（不监听端口）。 */
export async function inject(app, method, path, { token, headers = {}, payload } = {}) {
  const response = await app.inject({
    method,
    url: path,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload }),
  });
  const text = response.body;
  return {
    status: response.statusCode,
    body: text === '' ? null : JSON.parse(text),
    cacheControl: response.headers['cache-control'] ?? null,
  };
}

/**
 * 与 `makeHarness` 同一套装配，但**自己建审核域、自己建联动端口**并套一层只观察的包装，
 * 从而能断言"社区送审/下架时到底给审核域传了什么、拿回了什么"。
 *
 * 注意：包装**只记录**，所有调用原样委托给真实端口（`observeLink`）——
 * 这不是"用替身冒充结论"，审核域仍是那份真实实现。
 */
export function makeWiredHarness(options = {}) {
  const holder = {};
  const h = makeHarness({
    ...options,
    wireModeration: ({ store, authors, executionMode }) => {
      // 默认内容权威端口 = **同源社区权威**（与 `app.ts` 装配路径的口径一致）：
      // 审核域读/写的就是社区那一份 store 里的真实内容行，不是第二份副本。
      const authority = options.authority ?? createCommunityContentAuthority({ store, authors });
      const moderation =
        options.moderation ??
        createModerationService({
          executionMode,
          ...(options.ports === undefined ? {} : { ports: options.ports }),
          authority,
        });
      const { link, calls } = observeLink(createCommunityModerationLink({ moderation }));
      const communityModeration = options.communityModeration === undefined ? link : options.communityModeration;
      Object.assign(holder, { moderation, calls });
      return { service: moderation, communityModeration };
    },
  });
  return { ...h, moderation: holder.moderation, calls: holder.calls };
}

// ---------------------------------------------------------------------------
// 服务层 harness（不经 HTTP：用于 `real` 等无法装配社区路由的场景）
// ---------------------------------------------------------------------------

/**
 * 用**真实** `createCommunityService` + **真实** `createModerationService` +
 * **真实** `createCommunityModerationLink` 直接接线（与 `app.ts` 的接线口径逐条同形）。
 */
export function makeServiceHarness(options = {}) {
  const executionMode = options.executionMode ?? 'stub';
  const moderation =
    options.moderation ??
    createModerationService({
      executionMode,
      ...(options.ports === undefined ? {} : { ports: options.ports }),
      ...(options.authority === undefined ? {} : { authority: options.authority }),
    });
  const link = options.link ?? createCommunityModerationLink({ moderation });
  const store = options.store ?? createMemoryCommunityStore({ now: () => START });
  const service = createCommunityService({
    store,
    authors: options.authors ?? createLocalPseudonymousAuthorDirectory(),
    gate: options.gate ?? makeGate(),
    moderation: link,
    signingKey: 'gy-i14-i15-test-signing-key',
    now: options.now ?? (() => new Date(START)),
    newId: options.newId ?? makeIdFactory('9'),
  });
  return { moderation, link, store, service };
}

// ---------------------------------------------------------------------------
// 断言助手
// ---------------------------------------------------------------------------

/** 捕获 `ApiError`（contract 闭集错误码 + HTTP 状态 + retryable）。 */
export async function expectApiError(thunk, code, status) {
  try {
    await thunk();
  } catch (error) {
    assert.equal(typeof error?.code, 'string', `期望 ApiError.code 是字符串，实际 ${typeof error?.code}`);
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}`);
    if (status !== undefined) assert.equal(error.status, status, `期望 HTTP ${status}，实际 ${error.status}`);
    assert.equal(typeof error?.message, 'string');
    return error;
  }
  assert.fail(`期望抛出 ${code}，但调用成功了`);
}

/** 投稿正文（合成）。 */
export function postInput(over = {}) {
  return { title: SAFE_TITLE, body: SAFE_BODY, media_ids: [], ...over };
}
