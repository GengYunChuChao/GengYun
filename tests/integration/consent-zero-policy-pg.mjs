/**
 * R69 · `consent_policies` **0 行**时的真实后果矩阵（**真 PG + 生产装配 + 零注入**）。
 *
 * 为什么要有这一臂
 * ----------------
 * 只读侦察（`.pg17/tmp/r69-consent-gate/RECON.md` §7.1）给出了一张「0 政策行 ⇒ 每个入口返回什么」
 * 的矩阵，但每一格都是**读码推定**；侦察方自己把这条列为「最大的未核实项」：
 * 「无注入 + 真 PG + 零政策行 + 生产装配」这条路径，仓库里找不到任何实测记录。
 *
 * 既有实测分两类，**都不覆盖**这条路径：
 *   ① `docs/verification/gy-r30-public-posting-gate-20261022.md` §3：用 `privacyInjection.consent`
 *      注入**合成闸** + stub 模式 ⇒ 「闸是不是真 PG 闸」「403 是不是政策表 0 行造成的」都证明不了；
 *   ② `tests/integration/consent-grant-pg.mjs` / `egress-ledger-pg.mjs`：真 PG，但用
 *      **测试 owner + 合成政策夹具 + `allowSyntheticGrantPolicy`** ⇒ 政策表从来不是 0 行。
 * 本臂补的就是这条空档：**不注入 `privacyInjection`、不造假 gate、不给生产装配传
 * `consentGrantTestOptions`**，只 `buildApp({config,pool,wechat})`，把矩阵逐格打成断言。
 *
 * 本臂断言什么（逐条对应 RECON §7.1 / §7.2）
 * ---------------------------------------
 *   1. 真簇 + **全链迁移**（现场发现的全部 `NNNN_*.sql` 按版本序）后，`consent_policies` = **0 行**
 *      ——这是**前提**，不是结论；顺带读出 `admin_accounts` / `recipients` 行数（侦察 §9.4 未核实项）。
 *   2. `public_posting` 的 4 条写入口 ⇒ 403 `CONSENT_REQUIRED`（message 口径见下方「不一致」一栏）；
 *   3. `media_processing`：`POST /media/uploads` ⇒ 403；
 *   4. `external_inference` 的 **7 条**（OCR 3 条含 PATCH/verify、识别 2 条含 PATCH、转写、合成）⇒ 403；
 *   5. **授予路径自身** `POST /me/consents` ⇒ 403（钥匙在库外：产品内无路可走）；
 *   6. 读面 `GET /me/consents` ⇒ 200 空页；`GET /me/privacy-policy` ⇒ 200 `unpublished`；
 *   7. `DELETE /me/consents/{purpose}`：带 `If-Match` ⇒ 404，不带 ⇒ 428；
 *   8. 读可用面抽样（社区列表 / 媒体读 / `GET /ocr/{id}` / `GET /recognitions/{id}`）⇒ **不是 403**；
 *   9. **闸在最外层**（判据见下）：403 批次前后 **public 下每张表的行数逐表相等**，
 *      且 403 报文里**没有**审核域才有的 `details[].field === 'reason_codes'`；
 *  10. **决定性负控制**：往 `consent_policies` 插**一行** `public_posting` 的 `source_kind='synthetic'`
 *      政策（测试数据里显式标 synthetic），再发 `POST /posts` ⇒ **不再是** 403 `CONSENT_REQUIRED`。
 *      ⚠️ 实测与派单预期**不一致**（插一行并不够），逐级读数见下。
 *
 * 负控制为什么做成三级（本臂最重要的读数）
 * --------------------------------------
 * 派单假设「插一行 synthetic 政策 ⇒ `POST /posts` 直接不再 403」。读码
 * `services/api/src/privacy/grant-pg.ts:50-53` 显示**不成立**：闸（`consent-pg.ts:138-146`）根本
 * 不读 `consent_policies`，它读 `privacy_epochs ⨝ consent_records`；而 synthetic 政策在生产装配下
 * 被显式拒绝（`if (synthetic && !allowSynthetic) ⇒ CONSENT_REQUIRED '用途政策来源尚未核验'`）。
 * 故本臂把负控制拆成三级，**每一级都是实测读数**：
 *   L1 生产装配 + 1 行 synthetic 政策 ⇒ `POST /me/consents` **仍 403**（'用途政策来源尚未核验'），
 *      `POST /posts` **仍 403**——403 不是「政策行数」的直接函数。
 *   L2 同一行 + **测试通道装配**（`consentGrantTestOptions:{allowSyntheticGrantPolicy:true}`；
 *      闸本身仍是同一个真 PG 闸、同一个池）⇒ `POST /me/consents` 201 ⇒ `POST /posts` **不再是 403**，
 *      前进到审核层（`details[].field='reason_codes'`），内容行 0。
 *      ⇒ 这才是「403 由『库中没有**可用**政策行』造成」的决定性证明：两次实验之间唯一的差别就是
 *      「有没有一行可用政策」，装配/用户/会话/内容/库全同。
 *   L3 停用该行 ⇒ 新用户 `POST /me/consents` 又回到 403（**双向**）；并实测「已审核行不可删」
 *      （`DELETE` ⇒ 23514，0009 的不可变触发器）⇒ 该行只能停用，库由运行器整体丢弃（一次性）。
 *
 * 与侦察报告矩阵**不一致**的一格（本臂最重要的发现之一）
 * --------------------------------------------------
 * RECON §7.1 的脚注写：「报文里的 `message` 会**指名缺哪个用途**（不是泛泛的『无权限』）」。
 * **实测不成立**：生产装配下所有 12 条挂闸入口的 403 文案都是同一句固定文案
 * 「当前身份或用途授权不满足要求」，**不含用途码**。
 * 原因：`services/api/src/privacy/consent-pg.ts:90-96` 把 `work()` 里冒出来的**非 ApiError**
 * （`packages/privacy/guard.mjs:116` 的 `PrivacyError('CONSENT_REQUIRED','缺少用途授权：<purpose>')`）
 * 统一改写成那句固定文案；而侦察引用的 `gy-r30`/§7.3 那几条实测走的是 `privacyInjection.consent`
 * 注入的 `createGuardConsentGate`（`egress.ts:93-100`，直接把 `PrivacyError.message` 透传）——
 * **两条路不是同一条路**。⛔ 本臂不迁就现状：它把实测口径钉成常量 `PG_GATE_MESSAGE`，并额外断言
 * 「message 里不出现用途码」；将来文案被修好，本臂会红并逼着同步改这条引脚与报告。
 *
 * 「闸在最外层」用的判据，以及它为什么算数
 * --------------------------------------
 * 判据 A（结构性、非报文）：对 `public` 下**每一张** base table 做前后行数快照并逐表比对。
 *   若请求越过闸进了 handler，`community_posts` / `community_comments` / `community_idempotency` /
 *   `moderation_decisions` / `community_moderation_decisions` / `jobs` / `media` 等至少有一张会新增行
 *   （四个写入口都是「先审后发 + 幂等台账」）。逐表相等 ⇒ 请求**一行都没写**。
 * 判据 B（报文，且由**正控制**校准过）：403 的 `error.details` 里不得出现 `field === 'reason_codes'`。
 *   该标记只有审核域（规则层 `gate.evaluate` / 模型层 `mergeModeration`）会写
 *   （`community/service.ts:495,510`），**而本臂在 L2 的同一副装配上真的看到它出现了** ⇒ 判据 B 不是
 *   「永远为真」的空断言，它在本 harness 里有判别力。
 * 两条判据彼此独立：A 说「库里没留下东西」，B 说「报文里没有内层的标记」。
 *
 * 怎么跑
 * ------
 * 本臂**不自起集群**，与 `consent-grant-pg.mjs` / `egress-ledger-pg.mjs` 同形：一次性空库与端口由
 * 调用方提供（CI 里是 `services.postgres` + `CREATE DATABASE`，本地是本机 17.11 的一次性集群）：
 *   $env:CONSENT_ZERO_PG_TEST_URL='postgres://postgres@127.0.0.1:<port>/gengyun_consent_zero_test'
 *   node tests/integration/consent-zero-policy-pg.mjs
 * 缺该环境变量 ⇒ 与两个参考臂一样**立刻断言失败**（不是 SKIP、不是 77）：真库臂没跑起来就不是通过。
 *
 * 纪律
 * ----
 * · **零注入**：生产那一具不传 `privacyInjection`、不造假闸、不传 `consentGrantTestOptions`；
 *   测试通道那一具是本臂的**被测量**之一（不是替身：同一份 `buildApp`、同一个真池、同一个 PG 闸）。
 * · `wechat` 提供者按名注入是既有臂的统一做法（登录面需要一个身份提供者，与授权闸无关），
 *   返回 `subjectLookupHex`，不含任何真实凭据。
 * · 两个临时密钥（`SESSION_SIGNING_KEY` / `MEDIA_OBJECT_REF_KEY`）只在配置对象里，**输出只给布尔**。
 * · 不联网（除本机回环 PG）；不发任何真实第三方请求；不打印任何凭据值。
 * · 不依赖 ambient `CI` / `GITHUB_ACTIONS` / `CONTINUOUS_INTEGRATION`：`loadConfig()` 收到的是**显式
 *   环境对象**（不是 `process.env`），runner 上的环境变量一个都进不来；唯一的 ambient 旋钮
 *   `MODERATION_DEMO_PORT` 在开头显式删除（它会把审核模型层换成合成端口，污染判据 B 的读数）。
 * · 路径一律走 `new URL(…, import.meta.url)`（不用 `process.cwd()` 兜底、不做 `process.platform` 分支）。
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';

// ── ambient 旋钮显式清零：审核演示端口会替换模型层（= 判据 B 标记的来源），本臂要的是**默认生产装配**。
delete process.env.MODERATION_DEMO_PORT;

const url = new URL(process.env.CONSENT_ZERO_PG_TEST_URL ?? '');
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'CONSENT_ZERO_PG_TEST_URL 必须是 postgres URL');
assert.equal(url.search, '');
assert.equal(url.hash, '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), '只允许回环地址');
assert.equal(url.pathname, '/gengyun_consent_zero_test');
const DB_NAME = url.pathname.slice(1);

const MIGRATIONS_DIR = new URL('../../services/api/db/migrations/', import.meta.url);
const sqlFile = (rel) => readFileSync(new URL(`../../services/api/db/${rel}`, import.meta.url), 'utf8');

const owner = new pg.Client({ connectionString: url.href });
await owner.connect();

const sessionKey = randomBytes(32).toString('hex');
const mediaObjectRefKey = randomBytes(32).toString('hex');
const wechatKey = randomBytes(32).toString('hex');
const subjectLookupHex = (code) => createHmac('sha256', wechatKey).update(`synthetic\n${code}`).digest('hex');

const API = '/api/v1';
let production = null;
let testChannel = null;
let pool = null;
let passed = 0;
const say = (label) => {
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
};

/** 一次 HTTP 调用：不解包、不断言（断言在调用点，逐格可读）。 */
function makeHttp(origin) {
  return async (path, options = {}) => {
    const res = await fetch(`${origin}${API}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.headers ?? {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body, text, headers: res.headers };
  };
}

const q = async (text, params = []) => (await owner.query(text, params)).rows;
const countOf = async (table, where = '', params = []) =>
  Number((await owner.query(`SELECT count(*)::int n FROM public.${table} ${where}`, params)).rows[0].n);

/** 空库前提：本臂要求调用方给一个**没有 public 表**的库（与两个参考臂同形）。 */
async function assertFreshDatabase() {
  const tables = Number((await q(`SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'`))[0].n);
  assert.equal(tables, 0, `${DB_NAME} 必须是一个空库（public 下 0 张表），实际 ${tables} 张`);
}

/** 全链迁移：现场发现的全部 `NNNN_*.sql`，按版本号排序逐个应用（含本臂并不直接碰的表）。 */
async function applyAllMigrations() {
  const names = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4,}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const versions = names.map((name) => name.slice(0, 4));
  assert.equal(new Set(versions).size, versions.length, `迁移版本号重复：${versions.join(',')}`);
  for (const name of names) {
    await owner.query(sqlFile(`migrations/${name}`));
  }
  return names;
}

/** `public` 下每张 base table 的行数快照（「闸在最外层」判据 A 的载体）。 */
async function snapshotTables() {
  const tables = (
    await q(`SELECT table_name FROM information_schema.tables
             WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)
  ).map((row) => row.table_name);
  const snapshot = new Map();
  for (const table of tables) {
    snapshot.set(table, await countOf(`"${table}"`));
  }
  return snapshot;
}

/** 两份快照的差集（表名 → {before, after}）：空对象 = 一行都没变。 */
function snapshotDiff(before, after) {
  const diff = {};
  for (const [table, value] of before) {
    const now = after.get(table);
    if (now !== value) diff[table] = { before: value, after: now };
  }
  for (const [table, value] of after) {
    if (!before.has(table)) diff[table] = { before: null, after: value };
  }
  return diff;
}

let http;
let user;
async function login(target, code) {
  const res = await target('/auth/wechat', {
    method: 'POST',
    headers: { 'idempotency-key': `login-${code}-${randomUUID().slice(0, 8)}` },
    body: { code },
  });
  assert.equal(res.status, 200, `登录必须成功：${JSON.stringify(res.body)}`);
  assert.equal(res.body.meta.execution_mode, 'stub', '本臂按派单要求以 APP_EXECUTION_MODE=stub 装配');
  const row = (await q(`SELECT id FROM users WHERE wechat_subject_lookup=decode($1,'hex')`, [subjectLookupHex(code)]))[0];
  const session = (await q(`SELECT id FROM sessions WHERE token_hash=decode($1,'hex')`, [hashToken(res.body.data.access_token)]))[0];
  return { id: row.id, sessionId: session.id, token: res.body.data.access_token };
}

/** 写请求的统一形状（幂等键每次都新：避免把「同键不同体」的 409 混进矩阵读数）。 */
const write = (token, body, method = 'POST', headers = {}) => ({
  token,
  method,
  body,
  headers: { 'idempotency-key': `r69-${randomUUID().replaceAll('-', '').slice(0, 24)}`, ...headers },
});

/**
 * **实测出来的固定文案**（生产/PG 闸路径）：`services/api/src/privacy/consent-pg.ts:90-96`。
 *
 * 那里把 `work()` 里冒出来的**非 ApiError**（`packages/privacy/guard.mjs:116` 的
 * `PrivacyError('CONSENT_REQUIRED', '缺少用途授权：<purpose>')`）统一改写成这一句固定文案，
 * 于是**用途码在生产装配下根本不会出现在报文里**。这与侦察报告 §7.1 的脚注
 * （「报文里的 `message` 会指名缺哪个用途」）以及 `gy-r30` 的注入式实测（§7.3 第一行）**不一致**：
 * 那两条都走 `privacyInjection.consent` 注入的 `createGuardConsentGate`（`egress.ts:93-100`，
 * 直接把 `PrivacyError.message` 透传），而真实装配走的是 `createPostgresConsentGate`。
 * ⛔ 本臂不把断言改成「迁就现状」：它把**实测口径**钉死成常量，并额外断言
 * 「message 里不出现用途码」——将来若有人修好这句文案，本臂会红并要求同步改这条引脚与报告。
 */
const PG_GATE_MESSAGE = '当前身份或用途授权不满足要求';

/**
 * 断言一格「挂闸入口被拒」：状态码 + `error.code` + 不重试 + **无 details** + 固定文案（不点名用途码）。
 *
 * `details` 为空是「闸在最外层」判据 B 的**逐格**形态：审核域的标记只能出现在
 * `details[].field === 'reason_codes'` 上，闸的拒绝不带任何 details。
 */
function expectGateDenial(res, purpose) {
  assert.equal(res.status, 403, `期望 403，实际 ${res.status}：${JSON.stringify(res.body)}`);
  assert.equal(res.body.error.code, 'CONSENT_REQUIRED', JSON.stringify(res.body));
  assert.equal(res.body.error.retryable, false, 'CONSENT_REQUIRED 不是可重试错误');
  assert.deepEqual(res.body.error.details, [], '闸的拒绝不得携带 details（审核域标记只在内层出现）');
  assert.equal(
    res.body.error.message,
    PG_GATE_MESSAGE,
    `生产（PG 闸）路径的文案是固定的「${PG_GATE_MESSAGE}」（consent-pg.ts:90-96 会改写 guard 的原文），`
      + `实际：${res.body.error.message}`,
  );
  assert.equal(
    res.body.error.message.includes(purpose),
    false,
    `与侦察报告 §7.1 的不一致必须钉在这里：生产装配的 message **不**点名用途码 ${purpose}`
      + '（点名只发生在注入式 guard 闸那条路上）',
  );
  assert.equal(
    JSON.stringify(res.body).includes('MODEL_NOT_EVALUATED'),
    false,
    '403 报文不得含审核域原因码 MODEL_NOT_EVALUATED',
  );
  return res.body.error.message;
}

try {
  // ───────────────────────────────────────────────── 0. 真簇 + 空库 + 全链迁移 + 前提读数
  const version = (await q('SHOW server_version'))[0].server_version;
  assert.match(version, /^17\.11(?:\D|$)/, `本臂只认真 PG 17.11，实际 ${version}`);
  console.log(`Native PostgreSQL: ${version} @ ${url.hostname}:${url.port}${url.pathname}`);
  await assertFreshDatabase();
  const migrations = await applyAllMigrations();

  // 前提（不是结论）：政策表 **0 行**。侦察 §9.4 未核实的 `admin_accounts` 一并读出。
  const policies = await countOf('consent_policies');
  const admins = await countOf('admin_accounts');
  const recipients = await countOf('recipients');
  const grants = await countOf('consent_records');
  assert.equal(policies, 0, '前提：迁移跑完后 consent_policies 必须是 0 行');
  assert.equal(recipients, 0, '前提：迁移跑完后 recipients 必须是 0 行');
  assert.equal(grants, 0, '前提：迁移跑完后 consent_records 必须是 0 行');
  console.log(`READINGS: 迁移=${migrations.length} 个（${migrations[0]} → ${migrations.at(-1)}；库=${DB_NAME}）`);
  console.log(`READINGS: consent_policies=${policies} recipients=${recipients} consent_records=${grants}`);
  console.log(`READINGS: admin_accounts=${admins}（侦察 §9.4「造一行政策前有没有合法 reviewed_by 主体」的实测答案）`);
  say(`真 PG ${version} + 全链迁移 ${migrations.length} 个 ⇒ consent_policies=${policies} / recipients=${recipients} /`
    + ` consent_records=${grants} 行（前提，非结论）；admin_accounts=${admins} 行`);

  // ───────────────────────────────────────────────── 1. 生产装配（零注入）
  pool = createPool(url.href);
  const config = loadConfig({
    APP_EXECUTION_MODE: 'stub',
    LOG_LEVEL: 'silent',
    DATABASE_URL: url.href,
    SESSION_SIGNING_KEY: sessionKey,
    MEDIA_OBJECT_REF_KEY: mediaObjectRefKey,
  });
  assert.equal(config.executionMode, 'stub', '派单要求 APP_EXECUTION_MODE=stub');
  assert.equal(config.databaseUrl, url.href, 'DATABASE_URL 必须真的进配置（闸的装配条件就是 pool !== null）');
  assert.notEqual(config.sessionSigningKey, null, '临时会话密钥必须进配置');
  assert.notEqual(config.mediaObjectRefKey, null, '临时媒体对象键必须进配置（否则媒体域整域 503，读面抽样会被污染）');
  console.log(`READINGS: sessionSigningKey=${config.sessionSigningKey !== null} mediaObjectRefKey=${config.mediaObjectRefKey !== null}（只给布尔，不给值）`);

  const wechat = { exchange: async (code) => ({ subjectLookupHex: subjectLookupHex(code) }) };
  // ⚠ 生产装配：只有 config / pool / wechat。**不传** privacyInjection、**不传** consentGrantTestOptions。
  production = buildApp({ config, pool, wechat });
  const productionOrigin = await production.listen({ host: '127.0.0.1', port: 0 });
  http = makeHttp(productionOrigin);
  user = await login(http, 'zero-policy-user');
  say(`生产装配 buildApp({config,pool,wechat}) 起真 HTTP（host=${new URL(productionOrigin).host}，零 privacyInjection /`
    + ' 零 consentGrantTestOptions）+ POST /auth/wechat 登录会话就位');

  // ───────────────────────────────────────────────── 2. 矩阵 a：public_posting 四条写入口
  const beforeGate = await snapshotTables();
  const postId = randomUUID();
  const commentId = randomUUID();
  const postBody = { title: '零政策矩阵合成帖', body: '这是一条用于零政策矩阵取证的合成正文。', media_ids: [] };
  const publicPosting = [
    ['POST /posts', '/posts', write(user.token, postBody)],
    ['PATCH /posts/{id}', `/posts/${postId}`, write(user.token, postBody, 'PATCH')],
    ['POST /posts/{id}/comments', `/posts/${postId}/comments`, write(user.token, { body: '合成评论' })],
    ['PATCH /comments/{id}', `/comments/${commentId}`, write(user.token, { body: '合成评论（改）' }, 'PATCH')],
  ];
  for (const [label, path, options] of publicPosting) {
    const res = await http(path, options);
    expectGateDenial(res, 'public_posting');
    console.log(`  · ${label} ⇒ ${res.status} ${res.body.error.code}「${res.body.error.message}」`);
  }
  say('public_posting 4 条写入口（POST /posts、PATCH /posts/{id}、POST /posts/{id}/comments、'
    + 'PATCH /comments/{id}）⇒ 403 CONSENT_REQUIRED，文案为固定文案'
    + `「${PG_GATE_MESSAGE}」（**不**点名用途码，见头部「不一致」）`);
  console.log('DIVERGENCE: 侦察报告 §7.1 脚注「message 会指名缺哪个用途」在本臂**不成立**：'
    + '生产（PG 闸）路径的文案被 consent-pg.ts:90-96 改写成固定文案，用途码不出现在报文里；'
    + '点名只发生在注入式 guard 闸那条路（gy-r30 的实测口径）。');

  // ───────────────────────────────────────────────── 3. 矩阵 b：media_processing
  const uploadRes = await http(
    '/media/uploads',
    write(user.token, { purpose: 'weed_recognition', mime: 'image/png', bytes: 32, sha256: 'b'.repeat(64) }),
  );
  expectGateDenial(uploadRes, 'media_processing');
  console.log(`  · POST /media/uploads ⇒ ${uploadRes.status} ${uploadRes.body.error.code}「${uploadRes.body.error.message}」`);
  say('media_processing：POST /media/uploads ⇒ 403 CONSENT_REQUIRED（同一句固定文案）'
    + '（dataType 由 body.purpose 逐请求解析 ⇒ voice_question 场景同样先报这个码）');

  // ───────────────────────────────────────────────── 4. 矩阵 c：external_inference 七条
  // 侦察 §7.1 在这一用途下列了 7 条：OCR 3 条（POST /ocr、PATCH /ocr/{id}/correction、POST /ocr/{id}/verify）、
  // 识别 2 条（POST /recognitions、PATCH /recognitions/{id}/selection）、转写 1 条、合成 1 条。
  // 请求体都按各路由的 schema 造（validation 在 preHandler **之前**，畸形体会先得 400 而不显示闸），
  // 但内容本身不可能成功：被闸 403 挡在任何 handler 之前。
  const mediaId = randomUUID();
  const ocrId = randomUUID();
  const recognitionId = randomUUID();
  const labelFields = { registration_number: null, name: null, ingredients: [], dosage_form: null };
  const externalInference = [
    ['POST /ocr', '/ocr', write(user.token, { media_id: mediaId, media_revision: 1 })],
    ['PATCH /ocr/{id}/correction', `/ocr/${ocrId}/correction`, write(user.token, { corrected_fields: labelFields }, 'PATCH')],
    ['POST /ocr/{id}/verify', `/ocr/${ocrId}/verify`, write(user.token, { fields: labelFields })],
    ['POST /recognitions', '/recognitions', write(user.token, { media_id: mediaId, media_revision: 1 })],
    ['PATCH /recognitions/{id}/selection', `/recognitions/${recognitionId}/selection`,
      write(user.token, { selected_species_id: 'synthetic_species_a' }, 'PATCH')],
    ['POST /speech/transcriptions', '/speech/transcriptions', write(user.token, { media_id: mediaId, media_revision: 1 })],
    ['POST /speech/synthesis', '/speech/synthesis', write(user.token, {
      checked_content_ref: { type: 'answer', id: 'synthetic-answer-ref-1', revision: 1 },
      locale: 'zh-CN',
    })],
  ];
  for (const [label, path, options] of externalInference) {
    const res = await http(path, options);
    expectGateDenial(res, 'external_inference');
    console.log(`  · ${label} ⇒ ${res.status} ${res.body.error.code}「${res.body.error.message}」`);
  }
  say('external_inference 7 条入口（POST /ocr、PATCH /ocr/{id}/correction、POST /ocr/{id}/verify、'
    + 'POST /recognitions、PATCH /recognitions/{id}/selection、POST /speech/transcriptions、POST /speech/synthesis）'
    + '⇒ 403 CONSENT_REQUIRED（同一句固定文案）（转写也是 external_inference，**不是** recording——主用途先判）');

  // ───────────────────────────────────────────────── 5. 矩阵 d：授予路径自身
  const grantRes = await http(
    '/me/consents',
    write(user.token, { purpose: 'public_posting', policy_version: 'synthetic-v1', recipient_ids: [] }),
  );
  assert.equal(grantRes.status, 403, `授予路径在 0 政策行时必须 403：${JSON.stringify(grantRes.body)}`);
  assert.equal(grantRes.body.error.code, 'CONSENT_REQUIRED');
  assert.deepEqual(grantRes.body.error.details, []);
  assert.equal(await countOf('consent_records', 'WHERE user_id=$1', [user.id]), 0, '被拒的授予不得写 consent_records');
  assert.equal(await countOf('privacy_epochs', 'WHERE user_id=$1', [user.id]), 0, '被拒的授予不得写 privacy_epochs');
  console.log(`  · POST /me/consents ⇒ ${grantRes.status} ${grantRes.body.error.code}「${grantRes.body.error.message}」`);
  say('授予路径自身 POST /me/consents ⇒ 403 CONSENT_REQUIRED「没有可用的已核验用途政策」，且零 consent_records / privacy_epochs');

  // ───────────────────────────────────────────────── 6. 矩阵 e：读面（不挂闸）
  const listRes = await http('/me/consents', { token: user.token });
  assert.equal(listRes.status, 200, JSON.stringify(listRes.body));
  assert.deepEqual(listRes.body.data, { items: [], next_cursor: null }, '空授权必须是空页 + null 游标');
  const policyRes = await http('/me/privacy-policy', { token: user.token });
  assert.equal(policyRes.status, 200, JSON.stringify(policyRes.body));
  assert.equal(policyRes.body.data.version, 'unpublished', '0 政策行时政策读面的版本必须是 unpublished 哨兵');
  assert.deepEqual(policyRes.body.data.purposes, []);
  assert.deepEqual(policyRes.body.data.recipients, []);
  assert.equal(policyRes.body.data.training_enabled, false);
  console.log(`  · GET /me/consents ⇒ ${listRes.status} ${JSON.stringify(listRes.body.data)}`);
  console.log(`  · GET /me/privacy-policy ⇒ ${policyRes.status} version=${policyRes.body.data.version}`);
  say('读面 GET /me/consents ⇒ 200 {items:[],next_cursor:null}；GET /me/privacy-policy ⇒ 200 version=unpublished'
    + '（空态是诚实的 200，不是 5xx）');

  // ───────────────────────────────────────────────── 7. 矩阵 f：撤回的两档
  const withdrawNoMatch = await http('/me/consents/public_posting', write(user.token, undefined, 'DELETE'));
  assert.equal(withdrawNoMatch.status, 428, JSON.stringify(withdrawNoMatch.body));
  assert.equal(withdrawNoMatch.body.error.code, 'REVISION_REQUIRED');
  const withdrawWithMatch = await http(
    '/me/consents/public_posting',
    write(user.token, undefined, 'DELETE', { 'if-match': '"1"' }),
  );
  assert.equal(withdrawWithMatch.status, 404, JSON.stringify(withdrawWithMatch.body));
  assert.equal(withdrawWithMatch.body.error.code, 'NOT_FOUND');
  console.log(`  · DELETE /me/consents/public_posting（无 If-Match）⇒ ${withdrawNoMatch.status} ${withdrawNoMatch.body.error.code}`);
  console.log(`  · DELETE /me/consents/public_posting（If-Match "1"）⇒ ${withdrawWithMatch.status} ${withdrawWithMatch.body.error.code}`);
  say('DELETE /me/consents/{purpose}：不带 If-Match ⇒ 428 REVISION_REQUIRED（路由先拒）；带 ⇒ 404 NOT_FOUND'
    + '（没有可撤回的记录）');

  // ───────────────────────────────────────────────── 8. 矩阵 g：读可用面抽样（都不是 403）
  const afterGate = await snapshotTables();
  const readSurface = [
    ['GET /posts（社区列表）', '/posts', 200],
    ['GET /media/{id}（媒体读）', `/media/${randomUUID()}`, 404],
    ['GET /ocr/{id}', `/ocr/${randomUUID()}`, 404],
    ['GET /recognitions/{id}', `/recognitions/${randomUUID()}`, 404],
  ];
  for (const [label, path, expected] of readSurface) {
    const res = await http(path, { token: user.token });
    assert.notEqual(res.status, 403, `${label} 不该挂闸：${JSON.stringify(res.body)}`);
    assert.equal(res.status, expected, `${label} 期望 ${expected}，实际 ${res.status}：${JSON.stringify(res.body)}`);
    if (res.status === 200 && path === '/posts') {
      assert.deepEqual(res.body.data.items, [], '空社区列表必须是空页');
    }
    console.log(`  · ${label} ⇒ ${res.status}${res.body?.error === undefined ? '' : ` ${res.body.error.code}`}`);
  }
  say('读可用面抽样（社区列表 200 / 媒体读 404 / GET /ocr/{id} 404 / GET /recognitions/{id} 404）⇒ 都不是 403'
    + '（读码说这些不挂闸：本臂实测一致）');

  // ───────────────────────────────────────────────── 9. 闸在最外层：判据 A（结构性）
  const gateDiff = snapshotDiff(beforeGate, afterGate);
  assert.deepEqual(gateDiff, {}, `被 403 挡掉的请求不得在库里留下任何一行，实际变化：${JSON.stringify(gateDiff)}`);
  const watched = ['community_posts', 'community_comments', 'community_idempotency', 'community_moderation_decisions',
    'moderation_decisions', 'moderation_withdrawals', 'jobs', 'media'];
  for (const table of watched) {
    assert.equal(afterGate.get(table), 0, `${table} 在 403 批次之后必须是 0 行（审核层/业务层都没被进到）`);
  }
  console.log(`READINGS: 逐表快照 ${afterGate.size} 张表全部相等；采样 ${watched.join('/')} 均为 0 行`);
  say(`闸在最外层·判据 A：403 批次前后 public 下 ${afterGate.size} 张表的行数**逐表相等**`
    + `（含 ${watched.slice(0, 4).join('、')} 等 ${watched.length} 张审核/内容/幂等表均为 0 行）`);

  // ───────────────────────────────────────────────── 10. 闸在最外层：判据 B（报文，逐格已在上面断言）
  const markers = [listRes, policyRes].flatMap((res) => res.body?.error?.details ?? []);
  assert.deepEqual(markers, [], '读面也不该有 reason_codes');
  say('闸在最外层·判据 B：所有 403 的 error.details 逐条为空（无 reason_codes / 无 MODEL_NOT_EVALUATED）'
    + '——该标记只在审核层出现，下面 L2 会在同一副装配上真的看到它');

  // ───────────────────────────────────────────────── 11. 负控制 L1：插一行 synthetic 政策（生产装配仍 403）
  const reviewerId = (
    await q(`INSERT INTO admin_accounts(login_name, credential_hash)
             VALUES('synthetic-r69-reviewer', 'synthetic-unused-not-a-credential') RETURNING id`)
  )[0].id;
  assert.equal(await countOf('admin_accounts'), 1);
  const policyId = (
    await q(
      `INSERT INTO consent_policies(purpose, policy_version, source_kind, source_ref, content_sha256,
         review_evidence_ref, recipient_bindings, valid_from, valid_until, reviewed_by, reviewed_at, enabled)
       VALUES('public_posting', 'synthetic-v1', 'synthetic', 'fixture://policy/r69-public-posting',
         $1, 'fixture://policy/r69-review', '{}'::jsonb,
         clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour',
         $2, clock_timestamp(), true) RETURNING id`,
      ['a'.repeat(64), reviewerId],
    )
  )[0].id;
  // 测试数据里**显式标 synthetic**：source_kind / source_ref / review_evidence_ref 三处都写 fixture://
  const inserted = (await q(`SELECT purpose, policy_version, source_kind, source_ref, review_evidence_ref, enabled
                             FROM consent_policies WHERE id=$1`, [policyId]))[0];
  assert.equal(inserted.source_kind, 'synthetic');
  assert.match(inserted.source_ref, /^fixture:\/\//);
  assert.equal(inserted.enabled, true);
  assert.equal(await countOf('consent_policies'), 1, '负控制前提：政策表从 0 行变成恰好 1 行');
  console.log(`READINGS: 负控制插入 consent_policies 1 行（purpose=${inserted.purpose} version=${inserted.policy_version}`
    + ` source_kind=${inserted.source_kind} enabled=${inserted.enabled}）`);

  const grantL1 = await http(
    '/me/consents',
    write(user.token, { purpose: 'public_posting', policy_version: 'synthetic-v1', recipient_ids: [] }),
  );
  assert.equal(grantL1.status, 403, `生产装配必须拒绝 synthetic 政策（grant-pg.ts:51-53）：${JSON.stringify(grantL1.body)}`);
  assert.equal(grantL1.body.error.code, 'CONSENT_REQUIRED');
  assert.ok(grantL1.body.error.message.includes('尚未核验'), `实际 message：${grantL1.body.error.message}`);
  const postL1 = await http('/posts', write(user.token, postBody));
  expectGateDenial(postL1, 'public_posting');
  console.log(`  · L1 POST /me/consents ⇒ ${grantL1.status} ${grantL1.body.error.code}「${grantL1.body.error.message}」`);
  console.log(`  · L1 POST /posts ⇒ ${postL1.status} ${postL1.body.error.code}「${postL1.body.error.message}」`);
  say('负控制 L1（**与派单预期不一致的一格**）：插 1 行 synthetic 政策后，生产装配仍拒绝授予'
    + '（403「用途政策来源尚未核验」），POST /posts 仍 403——闸不读政策表，它读 consent_records');

  // ───────────────────────────────────────────────── 12. 负控制 L2：测试通道装配 ⇒ 不再 403
  // 唯一差别：`consentGrantTestOptions:{allowSyntheticGrantPolicy:true}`。闸本身仍是同一个真 PG 闸、
  // 同一个池、同一个用户/会话/内容 —— 这不是替身，是「同一副装配 + 一个政策来源开关」。
  testChannel = buildApp({ config, pool, wechat, consentGrantTestOptions: { allowSyntheticGrantPolicy: true } });
  const testOrigin = await testChannel.listen({ host: '127.0.0.1', port: 0 });
  const httpTest = makeHttp(testOrigin);
  const grantL2 = await httpTest(
    '/me/consents',
    write(user.token, { purpose: 'public_posting', policy_version: 'synthetic-v1', recipient_ids: [] }),
  );
  assert.equal(grantL2.status, 201, `测试通道装配下授予必须成功：${JSON.stringify(grantL2.body)}`);
  assert.equal(grantL2.body.data.purpose, 'public_posting');
  const postL2 = await httpTest('/posts', write(user.token, postBody));
  assert.notEqual(postL2.status, 403, `插了可用政策行 + 已授予 ⇒ 不得再是 403：${JSON.stringify(postL2.body)}`);
  assert.ok([400, 422].includes(postL2.status), `必须前进到硬规则/审核层的 400/422，实际 ${postL2.status}`);
  const reasonCodes = (postL2.body.error?.details ?? []).filter((entry) => entry.field === 'reason_codes');
  assert.ok(reasonCodes.length > 0, `审核层标记必须出现（判据 B 的判别力校准点）：${JSON.stringify(postL2.body)}`);
  const contentRows = await countOf('community_posts', 'WHERE author_id=$1', [user.id]);
  assert.equal(contentRows, 0, '先审后发：即使过了闸，未通过审核的内容也不得落库');
  console.log(`  · L2 POST /me/consents ⇒ ${grantL2.status}（epoch=${grantL2.body.data.epoch}）
  · L2 POST /posts ⇒ ${postL2.status} ${postL2.body.error.code} details=${JSON.stringify(reasonCodes)} 内容行=${contentRows}`);
  say(`负控制 L2（决定性）：同一行政策 + 测试通道装配 ⇒ POST /me/consents 201，POST /posts **不再是 403**，`
    + `实际 ${postL2.status} ${postL2.body.error.code} 且 details 带 ${reasonCodes.map((e) => e.code).join('/')}、内容行 ${contentRows}`);

  // ───────────────────────────────────────────────── 13. 负控制 L3：停用该行 ⇒ 双向回到 403 + 不可删
  await owner.query('UPDATE consent_policies SET enabled=false WHERE id=$1', [policyId]);
  assert.equal(await countOf('consent_policies', 'WHERE enabled'), 0, '停用后不得有启用的政策行');
  const freshUser = await login(http, 'zero-policy-user-after-retire');
  const grantL3 = await http(
    '/me/consents',
    write(freshUser.token, { purpose: 'public_posting', policy_version: 'synthetic-v1', recipient_ids: [] }),
  );
  assert.equal(grantL3.status, 403, `停用唯一可用政策行后授予必须又回到 403：${JSON.stringify(grantL3.body)}`);
  assert.equal(grantL3.body.error.code, 'CONSENT_REQUIRED');
  assert.ok(grantL3.body.error.message.includes('没有可用的已核验用途政策'), `实际 message：${grantL3.body.error.message}`);
  // 已审核行**不可删**（0009 的不可变触发器）：这是「只能停用、不能回收」的实际读数。
  let deleteCode = null;
  try {
    await owner.query('DELETE FROM consent_policies WHERE id=$1', [policyId]);
  } catch (error) {
    deleteCode = error.code;
  }
  assert.equal(deleteCode, '23514', `已审核政策行必须不可删（触发器 23514），实际 ${String(deleteCode)}`);
  assert.equal(await countOf('consent_policies'), 1, '该行仍在：负控制夹具只能停用，不能删除');
  console.log(`  · L3 停用后新用户 POST /me/consents ⇒ ${grantL3.status} ${grantL3.body.error.code}「${grantL3.body.error.message}」`);
  console.log(`  · L3 DELETE 已审核政策行 ⇒ ${String(deleteCode)}（不可删，只能停用；库由运行器整体丢弃）`);
  say('负控制 L3（双向）：停用该行后新用户 POST /me/consents 又回到 403「没有可用的已核验用途政策」；'
    + '且 DELETE 已审核行 ⇒ 23514（夹具只能停用，不能回收）');

  console.log(`\nREADINGS: admin_accounts=${await countOf('admin_accounts')}`
    + ` consent_policies=${await countOf('consent_policies')}（负控制夹具，已停用）`);
  console.log(`\nRESULT=PASS ${passed} 组；真实 PostgreSQL ${version}（本机隔离、仅回环）；未发出任何对外/付费请求；`
    + 'synthetic 政策行只是负控制夹具，**不是**生产政策证据');
} finally {
  await production?.close?.();
  await testChannel?.close?.();
  await pool?.end?.();
  await owner.end();
}
