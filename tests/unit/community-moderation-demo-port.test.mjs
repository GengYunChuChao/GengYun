/**
 * GY-R68 · **演示审核端口**（`MODERATION_DEMO_PORT=pass`，仅非 real）· 落地读数。
 *
 * ## 这条文件要证明什么（逐条对应用户裁决）
 * 用户已明确授权：演示环境要能发帖。做法是**显式**加一个**合成**审核端口，而不是放宽任何判据。
 * 本文件用同一份夹具、同一条 `POST /posts`、**只差两个旋钮**（执行模式 / 环境开关）给出读数：
 *
 * | # | 臂 | 旋钮 | 期望读数 |
 * |---|---|---|---|
 * | ① | 负控制（默认装配，零注入） | 不设 `MODERATION_DEMO_PORT` | `422 INPUT_UNCERTAIN` / 内容行 0 / `insertPost` 未被调用 / 两个端口仍是替身 |
 * | ①b | 负控制（取值不是 `pass`） | 设成 `1`（`true`/`on` 同义） | 与 ① 逐字相同：**只有 `pass` 才算开启** |
 * | ② | 正控制（产品装配 + 环境开关） | 非 real + `MODERATION_DEMO_PORT=pass` | `201` / `published`+`approved` / 内容行**恰好 1** / 审核台账能看出是**合成** |
 * | ③ | real 下必须被拒 | `APP_EXECUTION_MODE=real` + 设了开关 | `POST /posts` **503**、审核域 `submitScreening` **503**、能力位 `none`、启动日志**明说拒绝** |
 * | ④ | 负控制（`synthetic` 键是判据） | 同 ② 的端口，但删掉 `provider.synthetic` | 必须**红**：`422` + 0 行 + 理由码指向端口形状非法 |
 * | ⑤ | 启动日志读数 | 设了 / 没设 | 设了 ⇒ 日志出现 `moderation_demo_port: synthetic`；没设 ⇒ 不出现 |
 *
 * ## 声明（不得误读）
 * - **替身级证据**：演示端口是**合成** `pass`（`provider.synthetic === true`、四个网络 seam
 *   持有即抛错、零外呼、零凭据）。它**不证明**真实审核能力（真实 tms/ims 未授权、BizType 未核验、
 *   真实样本各 0，见 `docs/evaluation/sample-gap-register.md`），也不得被引用成召回率／误隔离率成绩。
 * - **没有放宽 fail-closed**：real 分支一个字没改 —— 未接真实端口即整域 503；缺端口仍 422。
 *   本文件第 ③ 支就是这条不变量在"开关设了"情形下的钉住读数。
 * - 测试侧唯一的额外旋钮是**规则层冻结时钟**（`FROZEN_RULE_OPTIONS`，与
 *   `tests/unit/community-moderation-negative-control.test.mjs` 同一惯例）：出厂预算
 *   `DEFAULT_RULE_BUDGET_MS = 50` 吃墙钟，机器抖动会把 `approved` 变成 `quarantined(RULE_TIMEOUT)`，
 *   等于把机器速度变成断言结果。它**只**透传给规则层（`app.ts` 的 `ruleOptions` 缝），
 *   不会让审核域跳过送审、也不会把模型层变成"已接线"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import {
  DEMO_PORT_ENV_FIELD,
  DEMO_PORT_ENV_PASS,
  DEMO_PORT_LOG_ENABLED,
  DEMO_PORT_LOG_REFUSED,
  createDemoModerationPort,
  demoPortModelVersion,
  demoPortRequested,
  resolveDemoModerationPorts,
} from '../../services/api/src/moderation/demo-port.ts';
import { CLEAN_BODY, CLEAN_TITLE, makeGate } from './community-fixtures.mjs';
import { FROZEN_RULE_OPTIONS } from './stall-hygiene-fixtures.mjs';
import { createPublicPostingConsent } from './community-posting-consent-fixtures.mjs';

const API = '/api/v1';
const START = Date.UTC(2026, 9, 28, 6, 0, 0);

function write(key) {
  return { 'idempotency-key': key };
}

function postBody() {
  return { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] };
}

/**
 * 环境开关的**唯一**设置点：设了就在 `t.after` 恢复，避免把开关漏给同进程的其它用例。
 * `undefined` = 不设（与"运维没配这个变量"逐字等价）。
 */
function setDemoSwitch(t, value) {
  const before = process.env[DEMO_PORT_ENV_FIELD];
  if (value === undefined) delete process.env[DEMO_PORT_ENV_FIELD];
  else process.env[DEMO_PORT_ENV_FIELD] = value;
  t.after(() => {
    if (before === undefined) delete process.env[DEMO_PORT_ENV_FIELD];
    else process.env[DEMO_PORT_ENV_FIELD] = before;
  });
}

/**
 * 起一个真实 loopback 的 `buildApp`（与负控制文件同一套夹具，只多两个旋钮）。
 *
 * @param {object} options
 * @param {boolean} [options.real] `true` ⇒ 只把 `config.executionMode` 改成 real（与
 *   `tests/unit/community-http.test.mjs:54-57` 同一写法：不为此伪造真实凭据）。
 * @param {object} [options.moderationInjection] 原样透传（本文件只在"删掉 synthetic 键"那一支用它）。
 * @param {boolean} [options.captureLog] `true` ⇒ 用 `logStream` 抓启动日志（`LOG_LEVEL=info`）。
 */
async function fixture(t, options = {}) {
  const time = START;
  const logs = [];
  const auth = createMemoryAuthStore();
  const community = createMemoryCommunityStore({ now: () => time });
  const base = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: options.captureLog === true ? 'info' : 'silent' });
  const config = options.real === true
    ? { ...base, executionMode: 'real', requiresRealCredentials: true }
    : base;
  const publicPosting = createPublicPostingConsent();
  const app = buildApp({
    config,
    store: auth,
    now: () => new Date(time),
    privacyInjection: { consent: publicPosting.gate },
    communityInjection: { store: community, gate: makeGate() },
    ...(options.moderationInjection === undefined ? {} : { moderationInjection: options.moderationInjection }),
    ...(options.captureLog === true
      ? { logStream: { write: (chunk) => { logs.push(String(chunk)); } } }
      : {}),
  });
  const created = await auth.createUser('a'.repeat(64));
  const token = 'synthetic-r68-demoport-token';
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
  return {
    app,
    call,
    community,
    logs,
    logText: () => logs.join(''),
    actor: { userId: created.id },
  };
}

// ---------------------------------------------------------------------------
// ① 负控制：不设环境变量 ⇒ 与今天逐字一致（422 + 0 行）
// ---------------------------------------------------------------------------

test('① 不设 MODERATION_DEMO_PORT（纯默认装配）⇒ POST /posts 仍 422 INPUT_UNCERTAIN、内容行 0、两端口仍是替身', async (t) => {
  setDemoSwitch(t, undefined);
  const h = await fixture(t);
  assert.deepEqual(await h.community.listPosts({ scope: 'all' }), [], '前置：内存 store 必须是空的');

  // 环境侧读数：没设 ⇒ 解析结果恒"未启用"。
  assert.equal(demoPortRequested({}), false, '不设变量 ⇒ 不得要求启用');
  assert.deepEqual(
    resolveDemoModerationPorts({ executionMode: 'stub', env: {} }),
    { requested: false, enabled: false, refused: false, ports: {} },
  );

  const created = await h.call('POST', `${API}/posts`, { headers: write('gy-r68-demoport-off-0001'), payload: postBody() });
  // 读数 1：状态码与错误码与今天逐字相同（隔离 ⇒ 422，不是 400、不是 503）。
  assert.equal(created.status, 422, `默认装配下必须仍 422，实得 ${created.status}：${JSON.stringify(created.body)}`);
  assert.equal(created.body.error.code, 'INPUT_UNCERTAIN');
  assert.equal(created.body.error.retryable, false);
  assert.equal(created.cache, 'no-store');
  assert.equal(created.body.data, undefined);
  // 读数 2：内容行 0 行（且"根本没写过"，不是"写了但读不到"）。
  assert.deepEqual(await h.community.listPosts({ scope: 'all' }), [], '内容行必须 0 行');
  // 读数 3：演示端口没有混进审核域 —— 两个端口都仍是出厂替身。
  assert.deepEqual(
    h.app.moderationService.counts().substitutes,
    ['tms', 'ims'],
    'tms/ims 必须都还是替身（演示端口未启用）',
  );
  assert.equal(h.app.moderationService.capabilities().text.state, 'substitute');
});

// ---------------------------------------------------------------------------
// ①b 负控制：取值不是 `pass` ⇒ 仍关闭（只有 `pass` 才算开启）
// ---------------------------------------------------------------------------

test('①b 取值不是 `pass`（`1`/`true`/`on`）⇒ 仍 422 + 0 行：开关只认 `pass`', async (t) => {
  setDemoSwitch(t, '1');
  const h = await fixture(t);

  for (const value of ['1', 'true', 'on', 'yes', '']) {
    assert.equal(demoPortRequested({ [DEMO_PORT_ENV_FIELD]: value }), false, `取值 ${JSON.stringify(value)} 不得开启演示端口`);
  }
  assert.equal(demoPortRequested({ [DEMO_PORT_ENV_FIELD]: ' pass ' }), true, '首尾空白 + 大小写不敏感应当仍认作 pass');

  const created = await h.call('POST', `${API}/posts`, { headers: write('gy-r68-demoport-off-0002'), payload: postBody() });
  assert.equal(created.status, 422, `取值不是 pass ⇒ 必须仍 422，实得 ${created.status}`);
  assert.equal(created.body.error.code, 'INPUT_UNCERTAIN');
  assert.deepEqual(await h.community.listPosts({ scope: 'all' }), [], '内容行必须 0 行');
  assert.equal(h.app.moderationService.counts().substitutes.length, 2, '两个端口都仍是替身');
});

// ---------------------------------------------------------------------------
// ② 正控制：非 real + 开关 ⇒ 201 / 恰好 1 行 / 台账能看出是合成审核
// ---------------------------------------------------------------------------

test('② 非 real + MODERATION_DEMO_PORT=pass ⇒ 201 published/approved、内容行恰好 1、台账证据标 synthetic', async (t) => {
  setDemoSwitch(t, DEMO_PORT_ENV_PASS);
  // 唯一测试侧旋钮：冻住审核域规则层时钟（理由见文件头声明）。
  const h = await fixture(t, { moderationInjection: { ruleOptions: FROZEN_RULE_OPTIONS } });
  assert.deepEqual(await h.community.listPosts({ scope: 'all' }), [], '前置：内存 store 必须是空的');

  const created = await h.call('POST', `${API}/posts`, { headers: write('gy-r68-demoport-on-0001'), payload: postBody() });
  assert.equal(created.status, 201, `演示端口下必须 201，实得 ${created.status}：${JSON.stringify(created.body)}`);
  assert.equal(created.etag, '"1"');
  assert.equal(created.cache, 'no-store');
  assert.equal(created.body.data.visibility, 'published', '合成明确放行 ⇒ 公开');
  assert.equal(created.body.data.audit_state, 'approved', '合成明确放行 ⇒ 已过审');

  // 内容行**恰好** 1 行，且就是这一条。
  const rows = await h.community.listPosts({ scope: 'all' });
  assert.equal(rows.length, 1, `store 里应恰好 1 行，实得 ${rows.length}`);
  assert.equal(rows[0].id, created.body.data.id);
  assert.equal(rows[0].visibility, 'published');

  // 审核台账：**能看出这是合成审核**（契约 `audit_state` 是闭集，不新增枚举；
  // 判据放在审核域自己的端口证据里：`provider.synthetic === true` + `origin === 'injected'`
  // + `model_version` 带 `synthetic-demo-` 前缀）。
  const tasks = h.app.moderationService.tasks({ type: 'post', id: created.body.data.id, revision: 1 });
  assert.equal(tasks.length, 1, `该 revision 应恰好 1 条审核任务，实得 ${tasks.length}`);
  const task = tasks[0];
  assert.equal(task.decision, 'approved', `任务结论应为 approved，实得 ${task.decision}`);
  assert.equal(task.evidence.provider.synthetic, true, '台账必须标记 synthetic（不得被读成真实审核）');
  assert.equal(task.evidence.provider.origin, 'injected', '来源应如实记为 injected（装配层注入）');
  assert.equal(task.evidence.provider.model_version, demoPortModelVersion('tms'));
  assert.match(task.model_version, /^synthetic-demo-/, `模型版本必须自曝是合成，实得 ${task.model_version}`);
  assert.equal(task.evidence.execution_mode, 'stub', '台账如实记录执行模式（演示/替身）');
  assert.deepEqual(
    task.evidence.model_kinds.map((entry) => ({ kind: entry.kind, synthetic: entry.synthetic })),
    [{ kind: 'tms', synthetic: true }],
    '端口执行证据同样标 synthetic',
  );

  // 契约读面（`GET /jobs/{id}`，kind=moderation）也能看出是合成版本 —— 复核者不用看代码。
  const job = await h.call('GET', `${API}/jobs/${task.job_id}`);
  assert.equal(job.status, 200, `审核作业读面应可用，实得 ${job.status}：${JSON.stringify(job.body)}`);
  assert.equal(job.body.data.kind, 'moderation');
  assert.equal(job.body.data.result.value.decision, 'approved');
  assert.equal(job.body.data.result.value.model_version, demoPortModelVersion('tms'));

  // 只有文本端口被演示端口接上：图片端口仍是替身（不顺手放宽带媒体链路）。
  assert.deepEqual(h.app.moderationService.counts().substitutes, ['ims'], 'ims 必须仍是替身');

  // 读面能看到它（写面通了，读面也通）。
  const feed = await h.call('GET', `${API}/posts`);
  assert.equal(feed.status, 200);
  assert.equal(feed.body.data.items.length, 1);
  assert.equal(feed.body.data.items[0].id, created.body.data.id);
});

// ---------------------------------------------------------------------------
// ③ real + 开关 ⇒ 必须仍被拒（fail-closed 不许被打开），且启动日志明说拒绝
// ---------------------------------------------------------------------------

test('③ APP_EXECUTION_MODE=real + 设了开关 ⇒ POST /posts 503、审核域 503、能力位 none，启动日志明说拒绝', async (t) => {
  setDemoSwitch(t, DEMO_PORT_ENV_PASS);

  // 纯函数读数（不依赖 HTTP）：real 恒不启用，且如实回 refused。
  assert.deepEqual(
    resolveDemoModerationPorts({ executionMode: 'real', env: { [DEMO_PORT_ENV_FIELD]: DEMO_PORT_ENV_PASS } }),
    { requested: true, enabled: false, refused: true, ports: {} },
  );

  const h = await fixture(t, { real: true, captureLog: true });

  // 读数 1：社区域在 real 未接线 ⇒ 503（与"没有这个开关"逐字相同，不因开关变成 201）。
  assert.equal(h.app.communityService, null, 'real 未接持久存储 ⇒ 社区域整体不装配');
  const created = await h.call('POST', `${API}/posts`, { headers: write('gy-r68-demoport-real-0001'), payload: postBody() });
  assert.equal(created.status, 503, `real 下必须仍 503，实得 ${created.status}：${JSON.stringify(created.body)}`);
  assert.equal(created.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(created.body.error.retryable, false);
  assert.equal(created.body.meta.execution_mode, 'real');

  // 读数 2：审核域本身整域 fail-closed（**不是**被演示端口放行的服务）。
  assert.equal(h.app.moderationService.execution_mode, 'real');
  assert.equal(h.app.moderationService.capabilities().text.state, 'none', 'real 下文本端口必须是 none（无端口）');
  assert.deepEqual(h.app.moderationService.counts().substitutes, [], 'real 下不得出现任何替身/演示端口');
  await assert.rejects(
    () => h.app.moderationService.submitScreening({
      actor: { userId: h.actor.userId, role: 'user', authEpoch: 1 },
      content: { target_ref: { type: 'post', id: '11111111-1111-4111-8111-111111111111', revision: 1 }, text: CLEAN_BODY, media: [] },
    }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `real 送审必须 503 PROVIDER_UNAVAILABLE，实得 ${error.code}`);
      assert.equal(error.status, 503);
      assert.equal(error.retryable, false);
      return true;
    },
    'real 下审核域必须 fail-closed 拒绝送审（演示端口不得被装上）',
  );

  // 读数 3：启动日志**明确拒绝**（运维看得见"你设了，但被拒了"）。
  const logText = h.logText();
  assert.match(logText, new RegExp(DEMO_PORT_LOG_REFUSED), `启动日志必须出现拒绝行，实得：${logText.slice(0, 800)}`);
  assert.match(logText, /APP_EXECUTION_MODE=real/, '拒绝行必须写明原因（real 模式）');
  assert.equal(logText.includes(DEMO_PORT_LOG_ENABLED), false, 'real 下不得出现"已启用"的日志行');
});

// ---------------------------------------------------------------------------
// ④ 负控制：`provider.synthetic` 这个键是判据 —— 删掉它必须红
// ---------------------------------------------------------------------------

test('④ 负控制 · 删掉 provider.synthetic ⇒ 同一请求变 422 + 0 行 + 端口形状非法（该键是有判据的）', async (t) => {
  setDemoSwitch(t, undefined);
  // 与 ② 完全同源：同一个演示端口，**只**删掉 `provider.synthetic` 一个键。
  const port = createDemoModerationPort('tms');
  assert.equal(port.provider.synthetic, true, '前置：出厂演示端口必须自曝 synthetic');
  delete port.provider.synthetic;

  const h = await fixture(t, { moderationInjection: { ports: { tms: port }, ruleOptions: FROZEN_RULE_OPTIONS } });
  const created = await h.call('POST', `${API}/posts`, { headers: write('gy-r68-demoport-nosyn-0001'), payload: postBody() });

  assert.equal(created.status, 422, `删掉 synthetic 后必须从 201 变 422（否则这个键不是判据），实得 ${created.status}：${JSON.stringify(created.body)}`);
  assert.equal(created.body.error.code, 'INPUT_UNCERTAIN');
  const codes = (created.body.error.details ?? []).map((entry) => entry.code);
  assert.ok(
    codes.includes('MODEL_LAYER_PORT_INVALID'),
    `理由码必须指向端口形状非法，实得 ${JSON.stringify(codes)}`,
  );
  assert.equal(codes.includes('MODEL_BLOCKED'), false, '端口形状非法 ≠ 内容驳回');
  assert.deepEqual(await h.community.listPosts({ scope: 'all' }), [], '内容行必须 0 行');
  assert.equal(h.app.moderationService.tasks({ type: 'post', id: '00000000-0000-4000-8000-000000000000', revision: 1 }).length, 0);
});

// ---------------------------------------------------------------------------
// ⑤ 启动日志读数：设了出现 `moderation_demo_port: synthetic`，没设不出现
// ---------------------------------------------------------------------------

test('⑤ 启动日志：设了开关 ⇒ 出现 `moderation_demo_port: synthetic`；没设 ⇒ 不出现', async (t) => {
  // 臂 A：设了（非 real）。
  setDemoSwitch(t, DEMO_PORT_ENV_PASS);
  const on = await fixture(t, { captureLog: true });
  const onLog = on.logText();
  assert.match(onLog, new RegExp(DEMO_PORT_LOG_ENABLED), `设了开关必须留下启用日志行，实得：${onLog.slice(0, 800)}`);
  assert.match(onLog, /结论恒 pass/, '启用日志必须写明结论恒 pass（不让运维误以为是真审核）');
  assert.match(onLog, /不是真实审核结论/, '启用日志必须写明不是真实审核结论');
  await on.app.close();

  // 臂 B：没设。
  const off = await (async () => {
    const saved = process.env[DEMO_PORT_ENV_FIELD];
    delete process.env[DEMO_PORT_ENV_FIELD];
    t.after(() => { if (saved !== undefined) process.env[DEMO_PORT_ENV_FIELD] = saved; });
    return fixture(t, { captureLog: true });
  })();
  const offLog = off.logText();
  assert.equal(offLog.includes(DEMO_PORT_LOG_ENABLED), false, `没设开关不得出现启用日志行，实得：${offLog.slice(0, 800)}`);
  assert.equal(offLog.includes(DEMO_PORT_LOG_REFUSED), false, '没设开关也不该出现拒绝行');
  // 反向对照：两个日志出口都只在"动了开关"时说话，默认装配的启动日志一字不多。
  assert.equal(onLog.length > 0, true, '捕获通道本身必须是通的（否则上面的"不出现"没有意义）');
});
