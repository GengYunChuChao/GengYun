/**
 * GY-R68 · P1-a · **负控制**：默认装配下 `POST /posts` 一定被审核门挡住（替身级证据）。
 *
 * ## 这条用例要证明什么（一句话）
 * 默认装配（**不注入任何审核端口、也不注入审核服务**）下，一条**干净**文本帖提交上去，
 * 得到的是 **422 `INPUT_UNCERTAIN`** + 理由码 `MODEL_NOT_EVALUATED`，**内容行 0 行**，
 * 而同一进程里 `GET /posts` 仍然 200 —— 即：**只有写面被审核门挡住**，不是路由坏了、
 * 不是鉴权坏了、也不是整个社区域 503。
 *
 * ## 为什么这条必须是「负控制」
 * 侦察报告（`.pg17/tmp/p1-social/RECON.md` §3）给出的结论是"默认装配下社区发不出去"，
 * 但它承认那是**两段实测拼接**（审核域探针 + 代码路径阅读），**没有**跑完整
 * `buildApp` + HTTP 提交。本文件补的就是这一步：把"拼出来的推断"钉成"可复跑的读数"。
 * 反过来说，**没有**本文件的第三条用例（合成 `pass` 端口 ⇒ 201 + 1 行）时，
 * 422 就有可能来自别的门（规则层、投稿授权闸、幂等、schema……）——那条正控制是
 * "422 确实来自审核门"的唯一证据。
 *
 * ## 三次读数（同一份夹具、同一条请求、只差审核端口）
 * | # | 臂 | 装配 | 期望读数 |
 * |---|---|---|---|
 * | 1 | 负控制（纯默认）| `buildApp` 连 `moderationInjection` 键都不传 ⇒ 审核域照出厂自建**替身端口** | `422 INPUT_UNCERTAIN` / 内容行 0 / `hard_rule_passed=true`（不是规则层挡的）/ `GET /posts` 200 |
 * | 2 | 负控制（默认 + 规则时钟冻结）| 同上，只多透传 `ruleOptions`（仍**没有** service/ports/authority） | 同上，且 `details[].code` **逐字**含 `MODEL_NOT_EVALUATED` |
 * | 3 | 正控制 | 注入**明确标注的合成** `pass` 端口（`provider.synthetic === true`、四网络 seam 持有即抛错） | `201` / `visibility=published`、`audit_state=approved` / 内容行恰好 1 |
 *
 * 臂 1 与臂 2 是**同一条判据的两次独立读数**：臂 1 证明"零旋钮的默认装配也挡"，
 * 臂 2 让理由码可被逐字断言（理由：规则预算吃墙钟，见下节）。两次读数在本次实测中
 * **逐字段相同**（证据页 `docs/verification/gy-r68-moderation-gate-20261028.md` §3）。
 *
 * ## 测试侧的旋钮（**不是**端口注入，全部披露）
 * 只冻结两处**规则求值时钟**，不碰任何审核端口与判据：
 *   1. `communityInjection.gate = makeGate()` —— 社区发布闸门的规则引擎冻结时钟（三臂都有）；
 *   2. `moderationInjection.ruleOptions = FROZEN_RULE_OPTIONS` —— 审核域规则层冻结时钟（仅臂 2）。
 * 理由与既有惯例一致（`tests/unit/community-http.test.mjs:80-91`、
 * `tests/unit/stall-hygiene-fixtures.mjs`）：出厂预算 `DEFAULT_RULE_BUDGET_MS = 50`
 * （`packages/moderation/constants.mjs:223`）吃墙钟，机器一抖动就变成 `RULE_TIMEOUT`
 * ⇒ 判决变 `quarantined` ⇒ 理由码里换成 `RULE_TIMEOUT` 而不是 `MODEL_NOT_EVALUATED`，
 * 等于**把机器速度变成断言结果**。冻结后 `now - started` 恒为 0，预算检查照跑。
 * ⛔ 注意：`ruleOptions` **只**透传给规则层（`services/api/src/app.ts:946-948`），
 * 它**不会**让审核域跳过送审、也不会让模型层变成"已接线"。
 *
 * ## 声明（不得误读，逐条）
 * - **替身级证据**：本文件三次读数都由**替身/合成**端口产生，**不证明**真实审核能力
 *   （真实 tms/ims 供应商未授权、BizType 未核验、200/200 真实样本为 0，见
 *   `docs/evaluation/sample-gap-register.md`）；也不能被引用成召回率／误隔离率成绩。
 * - **不是质量证据**：正文是合成文本（`community-fixtures.mjs` 的 `CLEAN_*`），
 *   账号是内存合成账号，不读真实 `.env`、不连真实库、零真实外呼。
 * - **没有放宽任何判据**：本文件只断言现状，不改 `services/**`、不把 fail-closed 写成
 *   skip/todo，也不给默认装配补"演示放行"后门（那属于用户裁决，见证据页）。
 * - 内存 store 断言 0 行；**PG 臂不在本文件**（无池 ⇒ `app.ts` 走内存实现），
 *   真库读数见 `tests/integration/community-pg.mjs` 的既有臂。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { CLEAN_BODY, CLEAN_TITLE, makeGate, makeSyntheticPassPort } from './community-fixtures.mjs';
import { FROZEN_RULE_OPTIONS, frozenModerationInjection } from './stall-hygiene-fixtures.mjs';
import { createPublicPostingConsent } from './community-posting-consent-fixtures.mjs';

const API = '/api/v1';
const START = Date.UTC(2026, 9, 28, 4, 0, 0);

/** 写头：`Idempotency-Key`（required，8..128）。 */
function write(key) {
  return { 'idempotency-key': key };
}

function postBody() {
  return { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] };
}

/**
 * 只包一层**写入观测**，不替换任何实现：`insertPost` / `putRefusalVerdict` 照常落到同一个
 * 内存 store（社区服务、审核域同源权威、后台读面共用这一个实例），额外把调用记下来。
 *
 * 为什么需要它：`POST /posts` 失败时响应里**不会**给出内容 id（也就没法定点 `getPost`），
 * 而"内容行不落库"这条判据必须能直接看到"**根本没有写过**"，不能只靠"列表里没看见"。
 */
function spyingStore(base) {
  const calls = { insertPost: [], putRefusalVerdict: [] };
  const store = {
    ...base,
    async insertPost(record, moderationRecord) {
      calls.insertPost.push({ record, moderationRecord });
      return base.insertPost(record, moderationRecord);
    },
    async putRefusalVerdict(record) {
      calls.putRefusalVerdict.push(record);
      return base.putRefusalVerdict(record);
    },
  };
  return { store, calls };
}

/**
 * 起一个真实 loopback 的 `buildApp`。
 *
 * `arm`：
 *   - `'default'`（负控制）——**不传** `moderationInjection.service`、**不传** `.ports`；
 *     唯一透传的是 `.ruleOptions`（冻结规则时钟，见文件头）。
 *   - `'synthetic-pass'`（正控制）——注入合成 `pass` 端口（明确标注 synthetic）。
 */
async function fixture(t, arm) {
  const time = START;
  const auth = createMemoryAuthStore();
  const baseCommunity = createMemoryCommunityStore({ now: () => time });
  const { store: community, calls } = spyingStore(baseCommunity);
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  const publicPosting = createPublicPostingConsent();
  // 三个臂的差别**只在** `moderationInjection` 这一个键上（见文件头表格）：
  //   - `'default-pure'`：连这个键都不传 —— 纯默认装配，零测试侧旋钮（审核域照出厂自建替身端口）；
  //   - `'default-frozen'`：仍**没有** service / ports / authority，只透传规则层时钟
  //     （`app.ts:946-948`），把 `DEFAULT_RULE_BUDGET_MS` 的墙钟依赖从断言里去掉；
  //   - `'synthetic-pass'`：注入明确标注的合成 `pass` 端口（正控制）。
  const moderation = arm === 'synthetic-pass'
    ? frozenModerationInjection({
      executionMode: 'stub',
      ports: { tms: makeSyntheticPassPort('tms') },
      store: baseCommunity,
    })
    : arm === 'default-frozen'
      ? { ruleOptions: FROZEN_RULE_OPTIONS }
      : undefined;
  const app = buildApp({
    config,
    store: auth,
    now: () => new Date(time),
    privacyInjection: { consent: publicPosting.gate },
    communityInjection: { store: community, gate: makeGate() },
    ...(moderation === undefined ? {} : { moderationInjection: moderation }),
  });
  const created = await auth.createUser('a'.repeat(64));
  const token = 'synthetic-r68-p1a-token';
  await auth.createSession({
    userId: created.id,
    tokenHashHex: hashToken(token),
    authEpoch: created.authEpoch,
    expiresAt: new Date(START + 48 * 3600_000),
    audience: 'user',
  });
  await publicPosting.grant(created.id);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());

  async function call(method, path, { headers = {}, payload } = {}) {
    const response = await fetch(url + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...headers,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? null : JSON.parse(text),
      etag: response.headers.get('etag'),
      cache: response.headers.get('cache-control'),
    };
  }
  return { app, call, community: baseCommunity, calls, actor: { userId: created.id } };
}

// ---------------------------------------------------------------------------
// 1. 负控制（a）：**纯**默认装配 —— 连 `moderationInjection` 键都不传
// ---------------------------------------------------------------------------

/**
 * 两条负控制臂共用的断言："写面被挡、读面可用、内容行 0 行、结论如实记为隔离"。
 *
 * 这里**不**断言具体理由码（`MODEL_NOT_EVALUATED` 由下一支用例在冻结规则时钟后逐字断言）：
 * 规则预算吃墙钟时理由码会换成 `RULE_TIMEOUT`，但两者都落在同一个"隔离 ⇒ 422 `INPUT_UNCERTAIN`"
 * 分支上 —— 状态码与"不落库"这两条判据在两种情形下**都一样**，因此这里可以稳定断言。
 */
async function assertWriteBlocked(h, created) {
  // ---- 读数 1：状态码与错误码（隔离 ⇒ 422，不是 400 驳回、不是 503 未接线） ----
  assert.equal(created.status, 422, `默认装配下 POST /posts 必须 422，实得 ${created.status}：${JSON.stringify(created.body)}`);
  assert.equal(created.body.error.code, 'INPUT_UNCERTAIN', JSON.stringify(created.body));
  assert.equal(created.cache, 'no-store');
  assert.equal(created.body.meta.execution_mode, 'stub');
  assert.equal(created.body.data, undefined, '错误响应不得携带成功封套');
  assert.equal(created.body.error.retryable, false, '同一条请求重试不会成功 ⇒ 不得报 retryable');
  assert.equal(typeof created.body.error.message, 'string');

  // ---- 读数 2：必须带理由码，且不是"模型明确驳回"（隔离 ≠ 驳回） ----
  const details = created.body.error.details;
  assert.ok(Array.isArray(details) && details.length > 0, `422 必须带理由码，实得 ${JSON.stringify(details)}`);
  assert.equal(details.every((entry) => entry.field === 'reason_codes'), true, JSON.stringify(details));
  const codes = details.map((entry) => entry.code);
  assert.equal(codes.includes('MODEL_BLOCKED'), false, '隔离 ≠ 驳回：不得出现模型驳回码');

  // ---- 读数 3：内容行不落库（直接看写入调用，不只看列表） ----
  assert.equal(h.calls.insertPost.length, 0, '内容行不得落库（insertPost 未被调用）');
  assert.deepEqual(await h.community.listPosts({ scope: 'all' }), [], 'store 里必须 0 行（不区分可见性）');

  // ---- 读数 4：拒绝结论**如实补录**为隔离（不是驳回、也不是通过） ----
  assert.equal(h.calls.putRefusalVerdict.length, 1, '未提交内容的结论应当补录一次（如实记录，不冒充驳回）');
  const verdict = h.calls.putRefusalVerdict[0];
  assert.equal(verdict.decision, 'quarantined', `结论应为隔离，实得 ${verdict.decision}`);
  assert.equal(verdict.target_ref.type, 'post');
  assert.equal(verdict.target_ref.revision, 1);
  assert.equal(verdict.hard_rule_passed, true, '规则层是通过的：挡住它的不是规则层');
  assert.equal(verdict.contract_complete, false, '模型层没有结论 ⇒ 结论不完整，不得自称已审完');

  // ---- 读数 5：同一进程里读面仍可用（只有写面被挡） ----
  const feed = await h.call('GET', `${API}/posts`);
  assert.equal(feed.status, 200, `GET /posts 必须仍可用，实得 ${feed.status}：${JSON.stringify(feed.body)}`);
  assert.deepEqual(feed.body.data.items, [], '被挡的帖子不得出现在公开列表里');
  assert.equal(feed.body.data.next_cursor, null);
  assert.equal(feed.cache, 'no-store');

  // 详情面同样可用（未命中 id 是 404，而不是整域 503）。
  const absent = await h.call('GET', `${API}/posts/00000000-0000-4000-8000-000000000000`);
  assert.equal(absent.status, 404, `未命中 id 应为同形 404（不是 503），实得 ${absent.status}`);
  return codes;
}

test('负控制（纯默认）· 零测试侧旋钮：POST /posts ⇒ 422 INPUT_UNCERTAIN，内容行 0，GET /posts 仍 200', async (t) => {
  const h = await fixture(t, 'default-pure');
  // 前置：空 store（下面的"0 行"才有意义）。
  assert.deepEqual(await h.community.listPosts({ scope: 'all' }), [], '前置：内存 store 必须是空的');

  const created = await h.call('POST', `${API}/posts`, {
    headers: write('gy-r68-p1a-neg-pure-0001'),
    payload: postBody(),
  });
  await assertWriteBlocked(h, created);
});

// ---------------------------------------------------------------------------
// 2. 负控制（b）：默认装配 + 审核域规则层冻结时钟 ⇒ 逐字断言理由码
// ---------------------------------------------------------------------------

test('负控制（默认装配）· POST /posts ⇒ 422 INPUT_UNCERTAIN + MODEL_NOT_EVALUATED，内容行 0 行', async (t) => {
  const h = await fixture(t, 'default-frozen');
  assert.deepEqual(await h.community.listPosts({ scope: 'all' }), [], '前置：内存 store 必须是空的');

  const created = await h.call('POST', `${API}/posts`, {
    headers: write('gy-r68-p1a-neg-0001'),
    payload: postBody(),
  });
  const codes = await assertWriteBlocked(h, created);

  // ---- 本支追加的判据：理由码**逐字**指向"模型层没有结论"（替身端口只回 `unsure`） ----
  assert.ok(
    codes.includes('MODEL_NOT_EVALUATED'),
    `理由码必须含 MODEL_NOT_EVALUATED，实得 ${JSON.stringify(codes)}`,
  );
  assert.ok(
    h.calls.putRefusalVerdict[0].reason_codes.includes('MODEL_NOT_EVALUATED'),
    `台账理由码同样必须是 MODEL_NOT_EVALUATED，实得 ${JSON.stringify(h.calls.putRefusalVerdict[0].reason_codes)}`,
  );
  // 错误文案把门的归属写在明面上（隔离 + 模型层未接线），便于复核者不看代码也能读懂。
  assert.match(created.body.error.message, /审核域/, `文案必须点明是审核域挡的，实得：${created.body.error.message}`);
  assert.match(created.body.error.message, /decision=quarantined/, created.body.error.message);
});

// ---------------------------------------------------------------------------
// 3. 正控制：注入**合成** pass 端口 ⇒ 201 且恰好落 1 行
// ---------------------------------------------------------------------------

test('正控制 · 合成 pass 端口：同一请求 ⇒ 201 published/approved，内容行恰好 1', async (t) => {
  const h = await fixture(t, 'synthetic-pass');
  assert.deepEqual(await h.community.listPosts({ scope: 'all' }), [], '前置：内存 store 必须是空的');

  const created = await h.call('POST', `${API}/posts`, {
    headers: write('gy-r68-p1a-pos-0001'),
    payload: postBody(),
  });
  assert.equal(created.status, 201, `合成 pass 端口下必须 201，实得 ${created.status}：${JSON.stringify(created.body)}`);
  assert.equal(created.etag, '"1"');
  assert.equal(created.cache, 'no-store');
  assert.equal(created.body.data.visibility, 'published', '明确放行 ⇒ 公开');
  assert.equal(created.body.data.audit_state, 'approved', '明确放行 ⇒ 已过审');

  // 内容行**恰好** 1 行，且就是这一条。
  assert.equal(h.calls.insertPost.length, 1, '内容行必须恰好写一次');
  const rows = await h.community.listPosts({ scope: 'all' });
  assert.equal(rows.length, 1, `store 里应恰好 1 行，实得 ${rows.length}`);
  assert.equal(rows[0].id, created.body.data.id);
  assert.equal(rows[0].revision, 1);
  assert.equal(rows[0].visibility, 'published');
  // 没有"未提交内容"的补录（这条路径是送审通过 ⇒ 结论随内容行同原子写入）。
  assert.equal(h.calls.putRefusalVerdict.length, 0, '放行路径不得产生拒绝结论补录');

  // 读面能看到它（写面通了，读面也通）。
  const feed = await h.call('GET', `${API}/posts`);
  assert.equal(feed.status, 200);
  assert.equal(feed.body.data.items.length, 1);
  assert.equal(feed.body.data.items[0].id, created.body.data.id);
});
