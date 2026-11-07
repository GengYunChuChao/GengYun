/**
 * GY-R87 · #1030（社区帖图片上限）· **真 SQL → 路由 → 响应信封** 的 HTTP 端到端（PostgreSQL 17）。
 *
 * ## 这条缺口是什么（派单原话：「真 SQL→路由→信封」的端到端仍无人覆盖）
 * 既有覆盖各缺一段，合起来仍然没有一个用例能说「上限判定真的走了库、真的经路由、真的按契约信封回话」：
 *   - `tests/integration/post-media-attachments-pg.mjs` 有**真库**，但直调
 *     `createPostgresCommunityStore` / `createPostgresMediaStore`，**不经路由、不出信封**；
 *   - `tests/unit/media-http-upload.test.mjs` 有 `app.inject` 与 503 信封，但计数端口是**替身**，
 *     既没有 PG，也没有「真数到第 4 张」这件事；
 *   - `#1057`（PR head `0e2e380a`，squash 合入 main 的是 `da96c9b6`）补的是**校验层**
 *     「一次提交 4 个 media_ids」的 `details[0] = { field: '/media_ids', code: 'post_image_limit' }`，不碰数据库。
 * 本脚本把三者接起来：**真 PG 17 + 真 `buildApp`（`executionMode='real'`）+ `app.inject` 走完整路由**，
 * 断言一路读到底的是 `services/api/src/media/store-pg.ts` 的 `countPendingCommunityImages`。
 *
 * ## 先读代码定语义（本脚本的断言形状由此而来，见证据页同名一节）
 * 「每帖 ≤3」有**两个互不相同的裁决点**，容易被写成同一条断言：
 *   ① **上传侧**：`services/api/src/media/service.ts` 的 `attachmentLimitFor()` 把计数端口的读数
 *      交给 `validateUploadInput(..., { mediaCountForPost })`；`packages/media/validate.mjs`
 *      在 `mediaCountForPost >= 3` 时抛 `details: [{ field: '/purpose', code: 'post_image_limit' }]`。
 *      而这个计数端口的真实现是 `countPendingCommunityImages(ownerId)`：
 *      `owner_id = $1` ∧ `purpose='community_image'` ∧ 状态在途 ∧ 24h 内 ∧ **未挂到未删除帖**。
 *      ⇒ 它数的是**每用户「待用池」**（在途、还没挂上去的图），**不是**「每帖」、也**不是**「owner 累计」。
 *      **挂载即释放**（挂上去就不算待用）、**删帖即释放**、**24h 自衰减**。
 *   ② **挂载侧**：`POST/PATCH /posts` 的 `media_ids` 在路由 schema 上就是 `maxItems: 3`
 *      （`services/api/src/routes/community.ts`），第 4 个 id 在**进服务层之前**就被 Fastify 挡下；
 *      再往下才是 0022 的数组 CHECK 与 0056 的 `UNIQUE(post_id, ordinal)` / `CHECK (ordinal BETWEEN 1 AND 3)`。
 *      首拒的**文案**在 main 上换过一次（PASS 5 的注释写了完整时序）：#1057 之前是 ajv 的
 *      `must NOT have more than 3 items`；#1057（`da96c9b6`）给两条路由挂了
 *      `preValidation: rejectMediaIdsOverflow`（函数体 `services/api/src/routes/community.ts:479`，
 *      挂在 `:214`（POST）/`:235`（PATCH）），preValidation 先于 schema 校验 ⇒ 首拒变成领域同款机器码。
 * 所以：
 *   - 「第 4 张上传」**不是**无条件 201 —— 只有**先把它腾出待用池**（挂到某个帖子上）之后才 201；
 *   - 上传侧拒绝的信封是 `400 INVALID_REQUEST` + `details[0] = { field: '/purpose', code: 'post_image_limit' }`；
 *   - 挂载侧 4 张的 HTTP 首拒信封是 `400 INVALID_REQUEST` + `details[0] = { field: '/media_ids',
 *     code: 'post_image_limit' }`（`message` = `每个帖子最多 3 张图片`），它来自路由层
 *     `rejectMediaIdsOverflow`；store 侧的 `postImageLimitError()`
 *     （`services/api/src/community/store-pg.ts:457`，同一个 `field`/`code`）经 HTTP **仍不可达**——
 *     preValidation 在进服务层之前就抢先拒了（PASS 5 用「不存在的 post id 也拿到同一个信封」钉住）；
 *   - real 模式下计数端口**未装配**时是 `503 PROVIDER_UNAVAILABLE` + `retryable: false` +
 *     `details[0] = { field: '/purpose', code: 'post_image_limit_unwired' }`（fail-closed）。
 *
 * ## 覆盖（每条一个 PASS 行；任一断言失败 ⇒ 非 0 退出）
 *   PASS 1 正控制：real 装配 + 用户 A 连传 3 张 ⇒ 全 201（`purpose=community_image`、`state=initiated`），
 *          计数端口自述 `kind === 'postgres'`，库里真有 3 行 `public.media`
 *   PASS 2 上传侧上限：第 4 张 ⇒ `400 INVALID_REQUEST` + `details[0]={field:'/purpose',code:'post_image_limit'}`、
 *          `retryable:false`；库里仍是 3 行（拒绝发生在写之前）
 *   PASS 3 正控制（挂载）：`POST /posts` 挂 1 张 ⇒ 201；两次 `PATCH` 递增到 3 张 ⇒ 200 且长度 3；
 *          库里 `post_media_attachments` 恰好 3 行、ordinal 1..3
 *   PASS 4 「挂载即释放」+ owner 隔离：另开用户 B 传满 3 张（B 第 4 张 ⇒ 400）；此时 A 的待用池已腾空
 *          ⇒ A 第 4 张上传 **201**（这条同时是负控制：把 `m.owner_id = $1::uuid` 删掉就变红）
 *   PASS 5 挂载侧上限（正控制）：`PATCH` 一次提交 4 个 `media_ids` ⇒ `400 INVALID_REQUEST` +
 *          `details[0] === { field: '/media_ids', code: 'post_image_limit' }`（#1057 的 preValidation
 *          抢先，**不是** ajv 文案）；同一个 4 元数组打到**不存在的** post id 上也拿到同一个信封
 *          ⇒ 首拒发生在进服务层之前；库里仍是 3 行（整笔没生效）
 *   PASS 6 状态过滤：A 再传 2 张、`DELETE` 掉其中 1 张，再传 1 张 ⇒ 仍 201（被删的行不进待用池；
 *          这条同时是负控制：把 `m.state IN (...)` 放宽到含 `deleted` 就变红）
 *   PASS 7 每帖 ≠ 每用户累计：把第 4 张挂到**另一个新帖 B** ⇒ 201 且长度 1
 *          （A 名下累计已有 7 行 `media`，仍能挂 —— 证明没有走「owner 累计」口径）
 *   PASS 8 fail-closed：注入「去掉 `countPendingCommunityImages` 的 PG 媒体库」⇒
 *          `503 PROVIDER_UNAVAILABLE` + `retryable: false` + `details[0]={field:'/purpose',code:'post_image_limit_unwired'}`，
 *          文案逐字等于 `ATTACHMENT_LIMIT_UNWIRED_MESSAGE`
 *
 * ## 合成声明（必须如实引用，不得当作真实能力证据）
 *   - 对象存储是 `createS3CompatibleObjectStore(...)` 的**合成端点**：只做本地预签名，不发一次网络请求，
 *     也不 PUT 任何字节（所以全程停在 `initiated`，不走 `/complete`）；
 *   - 审核域注入的是**合成端口**（`provider.synthetic === true`，不联网、无凭据）。real 模式下应用装配路径
 *     **拒绝**注入端口，因此这里注入的是**整个审核服务实例**（`moderationInjection.service`）——
 *     这是本轮唯一绕开「real 审核域整域 503」的注入点，社区侧仍走真实的
 *     `createCommunityModerationLink` 与真实的图片能力位读取（`imageReadiness`）。带媒体内容在审核域里
 *     恒为「隔离/待审」（规则层对媒体一律 `MEDIA_NOT_EVALUATED_BY_RULE_LAYER`），因此帖子落的是
 *     「私有 / 待审」——这与产品现状一致，不影响本脚本要证的计数语义；
 *   - 授权闸（`public_posting` / `media_processing` / `external_inference`）用仓库既有的
 *     `createPublicPostingConsent()` 夹具，`grant()` 走真实授权账本实现。
 *
 * ## 运行（自己起一次性的 PG 17 簇，仅回环、跑完即删）
 *   $env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'   # 必填：含 initdb/pg_ctl 的目录
 *   node tests/integration/post-media-attach-http-pg.mjs
 * 未设 `GY_PG_BIN`（或目录里没有 initdb/pg_ctl）⇒ 打印 SKIP 并以 **77** 退出（未取得，不是通过）。
 * 可选 `GY_R87_PG_ROOT`：临时簇数据目录的父目录（默认 `GY_PG_BIN` 的上一级，即 `.pg17\`；
 * 本机 `%TEMP%` 下 initdb 会 Permission denied，所以默认不落 `os.tmpdir()`）。
 *
 * ## 变异自证（负控制，本脚本不自己改生产代码）
 * 见证据页「变异自证」一节：手工把 `services/api/src/media/store-pg.ts` 的三处过滤条件依次改宽，
 * 本脚本必须在对应的 PASS 行变红，`git checkout --` 还原后重新全绿。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { createLocalPseudonymousAuthorDirectory } from '../../services/api/src/community/authors.ts';
import { createPostgresCommunityStore } from '../../services/api/src/community/store-pg.ts';
import { createObjectRefCipher } from '../../services/api/src/media/object-ref-cipher.ts';
import { createS3CompatibleObjectStore } from '../../services/api/src/media/object-store.ts';
import { createPostgresMediaStore } from '../../services/api/src/media/store-pg.ts';
import { approveRealMediaWiring } from '../../services/api/src/media/service.ts';
import { createModerationService } from '../../services/api/src/moderation/service.ts';
import { createCommunityContentAuthority } from '../../services/api/src/community/moderation-authority.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import {
  CLEAN_BODY,
  CLEAN_TITLE,
  FROZEN_CLOCK,
  makeGate,
  makeSyntheticPassPort,
} from '../unit/community-fixtures.mjs';
import { createPublicPostingConsent } from '../unit/community-posting-consent-fixtures.mjs';
import { pickFreePort } from './lib/free-port.mjs';

const API = '/api/v1';
const DB_NAME = 'gengyun_r87_i30_http_test';
const CLUSTER_PREFIX = 'gy-r87-i30http-';
/** 与 `tests/integration/media-persistence-pg.mjs` 同一把**合成**引用加密键（不是真实密钥）。 */
const OBJECT_REF_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f01a2b4c5d6e7f8091a2b3c4d5e6f70819';
/**
 * `services/api/src/media/service.ts` 的未接线文案（逐字；`tests/unit/media-attachment-limit.test.mjs` 早已钉死）。
 * 这里再钉一次是为了让「503 信封」这条在上海改文案时立刻变红，而不是悄悄放宽成 includes 子串。
 */
const UNWIRED_MESSAGE =
  '每帖上限计数未接线：无法判定「每帖 ≤3 张」图片槽位（缺权威每帖计数，社区图片上传暂不可用）';

// ---------------------------------------------------------------------------
// GY_PG_BIN 闸门（含 initdb/pg_ctl 的目录）；缺 ⇒ SKIP + 77
// ---------------------------------------------------------------------------
const binDir = (process.env.GY_PG_BIN ?? '').trim();
const tool = (name) => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);
if (binDir === '' || !existsSync(tool('initdb')) || !existsSync(tool('pg_ctl'))) {
  console.log(
    'SKIP: 未设置 GY_PG_BIN（含 initdb/pg_ctl 的目录）⇒ 真库臂跳过，'
      + '没有验证「真 SQL → 路由 → 响应信封」的图片上限端到端（未取得，不是通过）。',
  );
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本脚本不提供 --allow-skip）。');
  process.exit(77);
}

/**
 * 临时簇数据目录的父目录。默认放在 `GY_PG_BIN` 的上一级（即 `.pg17\`）——
 * **不要**用 `os.tmpdir()`：本机 `%TEMP%` 下 initdb 会以
 * `initdb: error: could not create directory ...: Permission denied` 失败（实测），
 * 而 `.pg17\` 下正常。
 */
const rootDir = process.env.GY_R87_PG_ROOT ?? join(dirname(binDir), 'r87-http-pg-tmp');
const dataDir = join(rootDir, `${CLUSTER_PREFIX}${randomBytes(4).toString('hex')}`);
const serverLog = join(rootDir, `${CLUSTER_PREFIX}client-${randomBytes(4).toString('hex')}.log`);
let port = 0;
let adminBase = '';
let targetUrl = '';

let passed = 0;
const say = (label) => {
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
};
const note = (line) => console.log(`  · ${line}`);

/** 子进程输出去**文件**：本机 sandbox 禁命名管道，用管道收会等到超时。 */
function runTool(name, args) {
  const fd = openSync(serverLog, 'a');
  try {
    return spawnSync(tool(name), args, {
      stdio: ['ignore', fd, fd],
      env: { ...process.env, PGCONNECT_TIMEOUT: '5' },
      timeout: 180_000,
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
}

function serverOptions() {
  const options = [`-p ${port}`, '-c listen_addresses=127.0.0.1', '-c max_connections=32'];
  if (process.platform !== 'win32') options.push(`-k ${dataDir}`);
  return options.join(' ');
}

function tailOfFile(file, maxLines = 15) {
  try {
    return readFileSync(file, 'utf8').replace(/\s+$/, '').split('\n').slice(-maxLines).join('\n');
  } catch (error) {
    return `（读不到 ${file}：${error.message}）`;
  }
}

async function startCluster() {
  port = await pickFreePort();
  adminBase = `postgresql://postgres@127.0.0.1:${port}`;
  targetUrl = `${adminBase}/${DB_NAME}`;
  // 只建父目录：Windows 上 initdb 会给自己新建的目录 `chmod`，目录若已存在则报
  // `could not change permissions of directory ...: Permission denied`。
  mkdirSync(rootDir, { recursive: true });
  assert.ok(basename(dataDir).startsWith(CLUSTER_PREFIX), `拒绝删除非本脚本创建的目录：${dataDir}`);
  rmSync(dataDir, { recursive: true, force: true });
  const init = runTool('initdb', [
    '-D', dataDir, '--no-sync', '--encoding=UTF8', '--locale=C', '-U', 'postgres', '--auth=trust',
  ]);
  assert.equal(init.status, 0, `initdb 失败（status=${init.status}，日志见 ${serverLog}）`);
  const start = runTool('pg_ctl', [
    '-D', dataDir, '-l', join(dataDir, 'server.log'), '-o', serverOptions(), '-t', '60', '-w', 'start',
  ]);
  assert.equal(
    start.status,
    0,
    `pg_ctl start 失败（status=${start.status}；server.log 尾部：\n${tailOfFile(join(dataDir, 'server.log'))}）`,
  );
  note(`临时集群：数据目录 ${dataDir}，端口 ${port}（只监听 127.0.0.1）`);
}

function stopCluster() {
  assert.ok(basename(dataDir).startsWith(CLUSTER_PREFIX), `拒绝删除非本脚本创建的目录：${dataDir}`);
  if (existsSync(join(dataDir, 'PG_VERSION'))) runTool('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop']);
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10 });
}

async function connectWithRetry(connectionString, attempts = 60) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2_000 });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await sleep(250);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
let owner = null;
let pool = null;
let app = null;
let unwiredApp = null;

try {
  await startCluster();
  const admin = await connectWithRetry(`${adminBase}/postgres`);
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();

  owner = await connectWithRetry(targetUrl);
  const version = (await owner.query('SHOW server_version')).rows[0].server_version;
  note(`PostgreSQL ${version}`);
  assert.match(version, /^17\./, `requires PostgreSQL 17，实际 ${version}`);

  // ---- 迁移：全链（含 0022 社区表、0056 post_media_attachments、0008 幂等台账）----
  const discovered = discoverMigrations();
  const versions = discovered.map((m) => m.version);
  assert.equal(new Set(versions).size, versions.length, `迁移版本号重复：${versions.join(',')}`);
  // 数组字面量：这四段是「全链里**必须出现**」的必需版本清单，**不是** apply 子集。
  // `migration-subset-coverage-pins` 的朴素扫描（任意「元素全是四位版本号」的数组）会把它当成子集声明，
  // 因此该文件的 `NAIVE_ONLY_SCRIPTS` 按 `{ file, why }` 登记了本脚本；带语境的识别不认为它是子集：
  // 本脚本跑的是 `discoverMigrations()` 全链 + `assert.deepEqual(applied, versions)` + 重跑 no-op。
  for (const required of ['0001', '0008', '0022', '0056']) {
    assert.ok(versions.includes(required), `迁移目录必须含 ${required}`);
  }
  assert.deepEqual(
    (await applyMigrations(owner, discovered)).applied,
    versions,
    '全链迁移必须逐条真正应用',
  );
  assert.equal((await applyMigrations(owner, discovered)).applied.length, 0, '重跑迁移必须是 no-op');
  note(`迁移：${versions.length} 段全链 apply（最大号 ${versions.at(-1)}），重跑 0 条`);

  // ---- 开启投稿面：迁移 0020 播的三个开关默认全关（`submissions_enabled=false`） ----
  // 走的是**真实开关表**（`public.feature_flags`，迁移 0020 的唯一权威状态），不是注入替身：
  // 「运营把投稿面打开」这件事本身就是生产路径，随后 `app.ts` 的 `createPortFlagReader(flagsPort)`
  // 在 `onReady` 时 `refresh()` 读到真值。改宽/绕过开关不在本脚本的证明范围（那条由
  // `tests/unit/admin-flag-gate.test.mjs` 的 F/E7 覆盖）。
  const opened = await owner.query(
    `UPDATE public.feature_flags
        SET enabled = true, revision = revision + 1, reason = $1, changed_at = now()
      WHERE key = 'submissions_enabled'
      RETURNING revision`,
    ['GY-R87 真库 HTTP 端到端：按运营口径开启投稿面'],
  );
  assert.equal(opened.rowCount, 1, '迁移 0020 必须已播下 submissions_enabled 这一行');
  note(`开关：public.feature_flags.submissions_enabled=true（revision=${opened.rows[0].revision}，真实开关表）`);

  // ---- 装配：real 执行模式 + 真 pool（媒体库与社区库都自动接 PG） ----
  pool = createPool(targetUrl);
  const communityStore = createPostgresCommunityStore({ pool });
  assert.equal(communityStore.persistent, true, 'PG 社区 store 必须自述持久化');
  const authors = createLocalPseudonymousAuthorDirectory();
  const communityContentAuthority = createCommunityContentAuthority({ store: communityStore, authors });

  const auth = createMemoryAuthStore();
  const createUser = async (tag) => {
    const user = await auth.createUser(tag.repeat(64));
    const token = mintOpaqueToken();
    await auth.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(Date.now() + 48 * 3600_000),
      audience: 'user',
    });
    // PG 侧 `media.owner_id` / `community_posts.author_id` 有 FK，必须在 `users` 里有同 id 的行。
    await owner.query('INSERT INTO users (id) VALUES ($1::uuid)', [user.id]);
    return { user, token };
  };
  const authorA = await createUser('a');
  const authorB = await createUser('b');

  // 授权：上传要 `community_image` 的三个用途，投稿要 `public_posting`，都走真实 grant。
  const consent = createPublicPostingConsent();
  for (const subject of [authorA, authorB]) {
    for (const purpose of ['media_processing', 'public_posting', 'external_inference']) {
      await consent.grant(subject.user.id, purpose);
    }
  }

  /**
   * 审核域：**注入整个服务实例**（不是 `ports`）。
   *
   * 为什么不能注入 `ports`：`app.ts` 的 `demoAwareModerationPorts()` 在 `real` 下**拒绝**注入端口
   * （否则等于用合成替身冒充真实审核）。注入 `moderationInjection.service` 是装配层唯一的显式替换点
   * （`app.ts:939-955` 的 `moderationInjection?.service ?? createModerationService(...)`），
   * 社区侧读到的图片能力位（`capabilities().image.state === 'wired'`）仍是真实的实现路径。
   */
  const moderation = createModerationService({
    executionMode: 'stub',
    ports: { tms: makeSyntheticPassPort('tms'), ims: makeSyntheticPassPort('ims') },
    authority: communityContentAuthority,
    ruleOptions: { clock: FROZEN_CLOCK },
  });
  assert.equal(
    moderation.capabilities().image.state,
    'wired',
    '审核域图片能力位必须自述 wired（否则带媒体投稿会被社区 fail-closed 拒掉，测不到计数语义）',
  );

  const syntheticRealStore = createS3CompatibleObjectStore({
    endpoint: 'https://cos.ap-shanghai.myqcloud.com',
    bucket: 'gengyun-media-placeholder',
    accessKey: 'synthetic-access-key-id',
    secretKey: 'synthetic-secret-key-value',
    region: 'ap-shanghai',
    forcePathStyle: false,
  });

  const realOptions = (overrides = {}) => ({
    config: {
      ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
      executionMode: 'real',
      sessionSigningKey: randomBytes(32).toString('hex'),
      mediaObjectRefKey: OBJECT_REF_KEY,
    },
    store: auth,
    pool,
    now: () => new Date(),
    mediaObjectStore: syntheticRealStore,
    realMediaApproval: approveRealMediaWiring({ reason: 'GY-R87 真库 HTTP 端到端：合成端点，零外呼' }),
    privacyInjection: { consent: consent.gate },
    communityInjection: { store: communityStore, authors, gate: makeGate() },
    moderationInjection: { service: moderation },
    ...overrides,
  });

  app = buildApp(realOptions());
  assert.notEqual(app.mediaService, null, '媒体域必须开启');
  assert.equal(app.mediaService.failClosedReason, null, `媒体域不得 fail-closed：${app.mediaService.failClosedReason}`);
  assert.equal(
    app.mediaService.attachmentCounter.kind,
    'postgres',
    `real + PG 媒体库时上限计数端口必须是 PG 实现，实际 ${app.mediaService.attachmentCounter.kind}`,
  );
  note(`计数端口：kind=${app.mediaService.attachmentCounter.kind}（note=「${app.mediaService.attachmentCounter.note}」）`);

  const call = async (token, method, path, extra = {}) => {
    const response = await app.inject({
      method,
      url: path,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(extra.payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...(extra.headers ?? {}),
      },
      ...(extra.payload === undefined ? {} : { payload: extra.payload }),
    });
    let body = null;
    try { body = response.json(); } catch { body = null; }
    return { status: response.statusCode, headers: response.headers, body, text: response.body };
  };

  let uploadSeq = 0;
  /** 上传一张 `community_image`（只到 `initiated`：本脚本不 PUT 字节、不调 `/complete`）。 */
  const uploadImage = (who, label) => {
    uploadSeq += 1;
    const bytes = Buffer.from(`synthetic-community-image-${uploadSeq}-${randomUUID()}`, 'utf8');
    return call(who.token, 'POST', `${API}/media/uploads`, {
      payload: {
        purpose: 'community_image',
        mime: 'image/jpeg',
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
      },
      headers: { 'idempotency-key': `r87-i30-${label}-${uploadSeq}` },
    });
  };

  const acceptedUpload = (reply, label) => {
    assert.equal(reply.status, 201, `${label}：上传必须 201，实际 ${reply.status} ${reply.text.slice(0, 500)}`);
    assert.equal(reply.body.data.media.purpose, 'community_image', `${label}：purpose 必须是 community_image`);
    assert.equal(reply.body.data.media.state, 'initiated', `${label}：未收字节前必须是 initiated`);
    assert.equal(reply.body.meta.execution_mode, 'real', `${label}：信封必须自述 real 执行模式`);
    return reply.body.data.media.id;
  };

  const postBody = (mediaIds, title = CLEAN_TITLE, body = CLEAN_BODY) => ({ title, body, media_ids: mediaIds });
  const mediaRows = async (userId) => (await owner.query(
    `SELECT id::text AS id, state::text AS state FROM public.media
      WHERE owner_id = $1::uuid ORDER BY created_at, id`,
    [userId],
  )).rows;
  const attachedRows = async (postId) => (await owner.query(
    `SELECT ordinal, media_id::text AS media_id FROM public.post_media_attachments
      WHERE post_id = $1::uuid ORDER BY ordinal`,
    [postId],
  )).rows;

  // =========================================================================
  // PASS 1 · 正控制：real 装配、连传 3 张
  // =========================================================================
  const a1 = acceptedUpload(await uploadImage(authorA, 'a1'), 'A 第 1 张');
  const a2 = acceptedUpload(await uploadImage(authorA, 'a2'), 'A 第 2 张');
  const a3 = acceptedUpload(await uploadImage(authorA, 'a3'), 'A 第 3 张');
  assert.equal((await mediaRows(authorA.user.id)).length, 3, '库里必须真有 3 行 media（不是内存登记册）');
  say('正控制：real + PG 装配下用户 A 连传 3 张 ⇒ 3× HTTP 201（purpose=community_image、state=initiated、meta.execution_mode=real）；'
    + `库里 public.media 恰 3 行；计数端口 kind=${app.mediaService.attachmentCounter.kind}`);

  // =========================================================================
  // PASS 2 · 上传侧上限（每用户待用池）：第 4 张
  // =========================================================================
  const rejected = await uploadImage(authorA, 'a4');
  assert.equal(rejected.status, 400, `第 4 张上传必须 400，实际 ${rejected.status} ${rejected.text.slice(0, 500)}`);
  assert.equal(rejected.body.error.code, 'INVALID_REQUEST', `信封码必须是 INVALID_REQUEST，实际 ${rejected.body.error.code}`);
  assert.deepEqual(
    rejected.body.error.details[0],
    { field: '/purpose', code: 'post_image_limit' },
    `details[0] 必须是上传侧既有机器码，实际 ${JSON.stringify(rejected.body.error.details)}`,
  );
  assert.equal(rejected.body.error.retryable, false, '`ApiError` 默认 retryable=false ⇒ 400 必须是 false');
  assert.match(rejected.body.error.message, /最多 3 张/, `文案必须点明上限，实际「${rejected.body.error.message}」`);
  assert.equal((await mediaRows(authorA.user.id)).length, 3, '被拒的上传不得落库（先判后写）');
  say(`上传侧上限：A 第 4 张 ⇒ HTTP 400 ${rejected.body.error.code} + details[0]=${JSON.stringify(rejected.body.error.details[0])}`
    + ` + retryable=${rejected.body.error.retryable}；库里仍 3 行媒体（拒绝发生在写之前）`);

  // =========================================================================
  // PASS 3 · 正控制（挂载）：1 → 2 → 3 张，全部经路由
  // =========================================================================
  const createdA = await call(authorA.token, 'POST', `${API}/posts`, {
    payload: postBody([a1]),
    headers: { 'idempotency-key': 'r87-i30-post-a-1' },
  });
  assert.equal(createdA.status, 201, `挂第 1 张建帖必须 201，实际 ${createdA.status} ${createdA.text.slice(0, 500)}`);
  const postA = createdA.body.data.id;
  assert.deepEqual(createdA.body.data.media_ids, [a1], '建帖后 media_ids 必须恰为 [a1]');

  const etag = createdA.headers.etag;
  assert.equal(typeof etag, 'string', '建帖响应必须带 ETag（PATCH 要用 If-Match）');
  const patched2 = await call(authorA.token, 'PATCH', `${API}/posts/${postA}`, {
    payload: postBody([a1, a2]),
    headers: { 'idempotency-key': 'r87-i30-post-a-2', 'if-match': etag },
  });
  assert.equal(patched2.status, 200, `挂第 2 张必须 200，实际 ${patched2.status} ${patched2.text.slice(0, 500)}`);
  assert.equal(patched2.body.data.media_ids.length, 2, '第 2 次挂载后长度必须是 2');
  assert.equal(patched2.body.data.revision, 2);

  const patched3 = await call(authorA.token, 'PATCH', `${API}/posts/${postA}`, {
    payload: postBody([a1, a2, a3]),
    headers: { 'idempotency-key': 'r87-i30-post-a-3', 'if-match': patched2.headers.etag },
  });
  assert.equal(patched3.status, 200, `挂第 3 张必须 200，实际 ${patched3.status} ${patched3.text.slice(0, 500)}`);
  assert.equal(patched3.body.data.media_ids.length, 3, '第 3 次挂载后长度必须是 3');
  assert.deepEqual(patched3.body.data.media_ids, [a1, a2, a3], 'media_ids 必须按提交顺序原样返回');
  assert.equal(patched3.body.data.revision, 3);

  const rowsA = await attachedRows(postA);
  assert.deepEqual(rowsA.map((row) => row.ordinal), [1, 2, 3], '库里挂载行必须 ordinal 1..3');
  assert.deepEqual(rowsA.map((row) => row.media_id), [a1, a2, a3], '库里挂载顺序必须与 media_ids 一致');
  say('正控制（挂载）：POST /posts 挂 1 张 ⇒ 201；PATCH 递增到 2、3 张 ⇒ 200/200 且 media_ids 长度 1→2→3；'
    + '库里 post_media_attachments 恰 3 行、ordinal 1..3、顺序与提交一致');

  // =========================================================================
  // PASS 4 · 「挂载即释放」+ owner 隔离（负控制：删 owner 过滤即红）
  // =========================================================================
  for (const label of ['b1', 'b2', 'b3']) {
    acceptedUpload(await uploadImage(authorB, label), `B ${label}`);
  }
  const bRejected = await uploadImage(authorB, 'b4');
  assert.equal(bRejected.status, 400, `B 的第 4 张也必须 400（同一口径对每个 owner 生效），实际 ${bRejected.status}`);
  assert.deepEqual(bRejected.body.error.details[0], { field: '/purpose', code: 'post_image_limit' });

  // A 此刻待用池为 0（3 张都在帖 A 上），B 的 3 张在途 ⇒ A 的第 4 张必须放行。
  const a4 = acceptedUpload(await uploadImage(authorA, 'a4'), 'A 第 4 张（挂载后）');
  assert.equal((await mediaRows(authorA.user.id)).length, 4);
  say('「挂载即释放」+ owner 隔离：B 传满 3 张后第 4 张 400；此时 A 的待用池已腾空 ⇒ A 的第 4 张上传 201'
    + `（A 名下累计 4 行 media，仍未触发上限 ⇒ 计的是待用池，不是 owner 累计）`);

  // =========================================================================
  // PASS 5 · 挂载侧上限（正控制）：一次提交 4 个 media_ids ⇒ 路由层 preValidation 的信封
  //
  // 时序（这条断言的形状由此而来；⛔ 不要再写成 ajv 文案）：
  //   · #1057 之前：`postBody.media_ids.maxItems: 3` 的 ajv 校验先失败，`app.ts` 把 `validation[]`
  //     折叠成 `400 INVALID_REQUEST` + `details[0].code = 'must NOT have more than 3 items'`；
  //   · #1057（PR head `0e2e380a`，squash 合入 main = `da96c9b6`）之后：
  //     `services/api/src/routes/community.ts:214`（POST /posts）与 `:235`（PATCH /posts/:id）都挂了
  //     `preValidation: rejectMediaIdsOverflow`（函数体 `:479`）。Fastify 的 preValidation
  //     **先于** schema 校验跑 ⇒ 首拒是路由层的
  //     `details[0] = { field: '/media_ids', code: 'post_image_limit' }` +
  //     `message = 每个帖子最多 3 张图片`，ajv 那句英文文案在 main 上已经拿不到
  //     （M5 变异就是把它改回 ajv 文案，必须变红）；
  //   · store 侧的 `postImageLimitError()`（`services/api/src/community/store-pg.ts:457`，
  //     `field`/`code` 与上面逐字相同）经 HTTP **仍不可达**：preValidation 在进服务层之前就抢先拒了。
  //     下面第二个探针（同一个 4 元数组打到**不存在的** post id 上，也拿到逐字相同的信封）就是
  //     「首拒发生在进服务层之前」的证据 —— 若首拒改由 store 裁决，那里会先撞 404（帖子不存在）。
  // =========================================================================
  const tooMany = await call(authorA.token, 'PATCH', `${API}/posts/${postA}`, {
    payload: postBody([a1, a2, a3, a4]),
    headers: { 'idempotency-key': 'r87-i30-post-a-4', 'if-match': patched3.headers.etag },
  });
  assert.equal(tooMany.status, 400, `4 个 media_ids 必须 400，实际 ${tooMany.status} ${tooMany.text.slice(0, 500)}`);
  assert.equal(tooMany.body.error.code, 'INVALID_REQUEST');
  assert.deepEqual(
    tooMany.body.error.details[0],
    { field: '/media_ids', code: 'post_image_limit' },
    `挂载侧首拒必须是路由层 rejectMediaIdsOverflow 的领域机器码（preValidation 先于 schema 校验），`
      + `不是 ajv 的 must NOT have more than 3 items；实际 details[0]=${JSON.stringify(tooMany.body.error.details[0])}`,
  );
  assert.equal(
    tooMany.body.error.message,
    '每个帖子最多 3 张图片',
    `首拒 message 必须是 rejectMediaIdsOverflow 的领域文案，实际 ${String(tooMany.body.error.message)}`,
  );
  const tooManyUnknownPost = await call(authorA.token, 'PATCH', `${API}/posts/${randomUUID()}`, {
    payload: postBody([a1, a2, a3, a4]),
    headers: { 'idempotency-key': 'r87-i30-post-unknown-4', 'if-match': '"0"' },
  });
  assert.equal(
    tooManyUnknownPost.status,
    400,
    `不存在的 post id + 4 个 media_ids：首拒仍应是 400（preValidation 在鉴权/存在性之前），`
      + `实际 ${tooManyUnknownPost.status} ${tooManyUnknownPost.text.slice(0, 300)}`,
  );
  assert.deepEqual(
    tooManyUnknownPost.body.error.details,
    [{ field: '/media_ids', code: 'post_image_limit' }],
    '对不存在的帖子，首拒信封必须与真实帖子上的逐字相同 ⇒ 拒点在进服务层之前'
      + '（不是 store 的 postImageLimitError）',
  );
  const afterTooMany = await attachedRows(postA);
  assert.deepEqual(afterTooMany.map((row) => row.media_id), [a1, a2, a3], '被拒的 PATCH 不得改动挂载行（整笔没生效）');
  note(`挂载侧 4 张的信封：HTTP ${tooMany.status} ${tooMany.body.error.code} / details[0]=${JSON.stringify(tooMany.body.error.details[0])}`
    + ` / 不存在的 post id 也同信封（HTTP ${tooManyUnknownPost.status}）`);
  say('挂载侧上限（正控制）：PATCH 一次提交 4 个 media_ids ⇒ HTTP 400 INVALID_REQUEST + '
    + 'details[0]={field:/media_ids,code:post_image_limit} + message=每个帖子最多 3 张图片'
    + '（#1057 的 preValidation 抢先，不是 ajv 文案；store 的 postImageLimitError 经 HTTP 仍不可达）；'
    + '不存在的 post id 也拿到同一个信封 ⇒ 首拒在进服务层之前；库里挂载行仍是 3 行');

  // =========================================================================
  // PASS 6 · 状态过滤：被删的行不进待用池（负控制：放宽 state 即红）
  // =========================================================================
  const a5 = acceptedUpload(await uploadImage(authorA, 'a5'), 'A 第 5 张');
  const a6Reply = await uploadImage(authorA, 'a6');
  const a6 = acceptedUpload(a6Reply, 'A 第 6 张');
  const deletedA6 = await call(authorA.token, 'DELETE', `${API}/media/${a6}`, {
    headers: { 'idempotency-key': 'r87-i30-delete-a6', 'if-match': a6Reply.headers.etag },
  });
  assert.equal(deletedA6.status, 202, `DELETE /media/{id} 必须 202，实际 ${deletedA6.status} ${deletedA6.text.slice(0, 400)}`);
  const a6Row = (await owner.query('SELECT state::text AS state FROM public.media WHERE id = $1::uuid', [a6])).rows[0];
  assert.equal(a6Row.state, 'deleted', `删掉的媒体行必须落 state=deleted，实际 ${a6Row.state}`);

  // 待用池：a4、a5 在途（2 张）；a6 已删（不计）⇒ 第 7 张仍应放行。
  const a7 = acceptedUpload(await uploadImage(authorA, 'a7'), 'A 第 7 张（删一张之后）');
  assert.equal((await mediaRows(authorA.user.id)).length, 7, 'A 名下累计应有 7 行 media');
  say('状态过滤：A 再传 2 张（a5/a6）后 DELETE 掉 a6（state=deleted），再传 a7 ⇒ 仍 201'
    + '（已删的行不进待用池；A 名下累计 7 行 media）');

  // =========================================================================
  // PASS 7 · 每帖 ≠ 每用户累计：第 4 张挂到另一个新帖
  // =========================================================================
  const createdB = await call(authorA.token, 'POST', `${API}/posts`, {
    payload: postBody([a4], '苗期观察记录', '这段时间天气转凉，我记录了田间长势，准备按标签说明处理。'),
    headers: { 'idempotency-key': 'r87-i30-post-b-1' },
  });
  assert.equal(createdB.status, 201, `第 4 张挂新帖必须 201，实际 ${createdB.status} ${createdB.text.slice(0, 500)}`);
  assert.deepEqual(createdB.body.data.media_ids, [a4], '新帖 B 的 media_ids 必须恰为 [a4]');
  const postB = createdB.body.data.id;
  assert.notEqual(postB, postA, '新帖必须是另一个帖子');
  const rowsB = await attachedRows(postB);
  assert.deepEqual(rowsB.map((row) => row.media_id), [a4], '库里新帖只挂第 4 张');
  assert.deepEqual((await attachedRows(postA)).map((row) => row.media_id), [a1, a2, a3], '帖 A 的挂载不受影响');
  say('每帖 ≠ 每用户累计：A 的第 4 张（a4）挂到另一个新帖 B ⇒ 201 且长度 1；帖 A、帖 B 各自 3 张 / 1 张，'
    + '互不干扰（A 名下累计 7 行 media 仍可挂载 ⇒ 没有走 liveCommunityImageCount 的累计口径）');

  // =========================================================================
  // PASS 8 · fail-closed：real 模式下计数端口未装配
  // =========================================================================
  const pgMediaStore = createPostgresMediaStore({
    pool,
    cipher: createObjectRefCipher(OBJECT_REF_KEY),
  });
  assert.equal(typeof pgMediaStore.countPendingCommunityImages, 'function', 'PG 媒体库必须自带待用池计数');
  // 只摘掉计数口：其余方法原样委托给同一份 PG 实现（不改生产代码，只在装配层注入）。
  const strippedStore = { ...pgMediaStore, countPendingCommunityImages: undefined };
  unwiredApp = buildApp(realOptions({ mediaStore: strippedStore }));
  assert.equal(
    unwiredApp.mediaService.attachmentCounter.kind,
    'unwired',
    `摘掉计数口后上限端口必须是 unwired，实际 ${unwiredApp.mediaService.attachmentCounter.kind}`,
  );
  const unwiredReply = await unwiredApp.inject({
    method: 'POST',
    url: `${API}/media/uploads`,
    headers: {
      authorization: `Bearer ${authorA.token}`,
      'content-type': 'application/json',
      'idempotency-key': `r87-i30-unwired-${randomUUID()}`,
    },
    payload: {
      purpose: 'community_image',
      mime: 'image/jpeg',
      bytes: 32,
      sha256: sha256Hex(Buffer.from('synthetic-unwired-probe', 'utf8')),
    },
  });
  const unwiredBody = unwiredReply.json();
  assert.equal(unwiredReply.statusCode, 503, `未装配计数器必须 503，实际 ${unwiredReply.statusCode} ${String(unwiredReply.body).slice(0, 400)}`);
  assert.deepEqual(
    unwiredBody.error,
    {
      code: 'PROVIDER_UNAVAILABLE',
      message: UNWIRED_MESSAGE,
      retryable: false,
      details: [{ field: '/purpose', code: 'post_image_limit_unwired' }],
    },
    `未接线的错误信封必须逐字相同，实际 ${JSON.stringify(unwiredBody.error)}`,
  );
  say('fail-closed：real 模式注入「摘掉 countPendingCommunityImages 的 PG 媒体库」⇒ HTTP 503 '
    + 'PROVIDER_UNAVAILABLE + retryable=false + details[0]={field:/purpose,code:post_image_limit_unwired}（文案逐字）');

  console.log(`[ALL PASS] 真库 HTTP 端到端：#1030 图片上限的「真 SQL → 路由 → 信封」链路共 ${passed} 组 PASS`);
} catch (error) {
  console.error(`FAIL: ${error?.stack ?? error}`);
  console.error(`工具日志：${serverLog}`);
  process.exitCode = 1;
} finally {
  if (app !== null) await app.close().catch(() => {});
  if (unwiredApp !== null) await unwiredApp.close().catch(() => {});
  if (pool !== null) await pool.end().catch(() => {});
  if (owner !== null) await owner.end().catch(() => {});
  try {
    stopCluster();
  } catch (error) {
    console.error(`清理临时集群失败：${error?.message ?? error}`);
    process.exitCode = process.exitCode === 0 ? 1 : process.exitCode;
  }
}
