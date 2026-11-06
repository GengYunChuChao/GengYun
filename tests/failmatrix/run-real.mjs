#!/usr/bin/env node
/**
 * GY-I22（#22）失败回归矩阵 · **真实 PostgreSQL 17 运行臂**。
 *
 * 干什么：把失败回归矩阵的**权限面用例**（C1–C4 / C10 / C11，共 180 条）跑在
 * **一次性真实 PostgreSQL 17 集群**上，把矩阵 world 的内存 store 换成真 PG store，
 * 逐条记录 `stub 期望`（cases.mjs 里的 `expect`）与 `真 PG 实际` 的差异。
 *
 * 为什么需要这一臂：`run.mjs` 固定 `execution_mode=stub`，内存 store 与 PG store 的行为差异
 * 一直没有实测读数（README「未取得」一节里明确记着「真实 PG 下的同一矩阵」未验）。这一臂
 * 只补**证据**，不改矩阵本身，也不改业务代码。
 *
 * 作业过滤腿（S-6，C3-28…C3-36）**真跑**：真库侧的作业读面是 `createPostgresAdminJobPort`
 * （`services/api/src/app.ts:1380-1382`：real + 有池时装配），它读四张域内作业表
 * （`ocr_jobs` / `recognition_jobs` / `speech_jobs` / `conversation_turns`）⇒ 裸 SQL 就能播种，
 * 「真库无作业读权威可播种」的旧跳过理由已不成立。种子见 `seedFailClosedRowsReal` 末尾的 S8。
 *
 * 本臂**不宣称 #22 完成**：media/community 投稿/识别/OCR/转写等域在 real 模式下
 * fail-closed（未接线真实对象存储 / 真实供应商 / 真实媒体），这些域对应的越权用例
 * 无法在真 PG 上播种属主行 ⇒ 如实标 `not-runnable` 并写明原因，不伪装成 PASS。
 *
 * 运行：
 *   $env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'   # 必填：含 initdb/pg_ctl 的目录（PG 17.x）
 *   node tests/failmatrix/run-real.mjs
 *   node tests/failmatrix/run-real.mjs --json=out.json       # 另存机读结果
 *
 * 退出码（**跳过 ≠ 通过**）：
 *   0   真库起得来、矩阵权限面在真 PG 上取得逐条读数，且如实记录差异（不是「全绿」才算 0）；
 *   77  没设 GY_PG_BIN ⇒ **未取得**（POSIX skipped），不是通过；`--allow-skip`/`GY_ALLOW_SKIP=1` 才降级 0（仅本机开发，⛔ 不得接门禁）；
 *   其它非 0（通常 1）真失败（集群起不来 / 迁移失败 / 装配抛错）。
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASES, FAMILIES } from './cases.mjs';
import { API, SPECIES_ID, envelopeShape, inject, seedReceiptHolder } from './world.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const binDir = (process.env.GY_PG_BIN ?? '').trim();
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';

// ---------------------------------------------------------------------------
// 闸门：没有 PG 二进制就**未取得**，绝不伪装 PASS。
// ---------------------------------------------------------------------------
const TOOL = (name) => path.join(binDir, process.platform === 'win32' ? `${name}.exe` : name);
if (binDir === '' || !existsSync(TOOL('initdb'))) {
  console.log('SKIP: 未设置 GY_PG_BIN（含 initdb/pg_ctl 的目录）⇒ 真库臂跳过，没有在真实 PG 17 上跑失败矩阵的权限面用例（未取得，不是通过）。');
  console.log('SKIP: 本臂只认 GY_PG_BIN 指向的 PG 17 二进制（initdb/pg_ctl），找不到就整臂未取得。');
  if (ALLOW_SKIP) {
    console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
    process.exit(0);
  }
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped）。');
  process.exit(77);
}

// 依赖在闸门之后才动态加载：没有 GY_PG_BIN 时连 pg 都不 import，与既有 -pg.mjs 集成测试同一口径。
const pg = (await import('pg')).default;
const { buildApp } = await import('../../services/api/src/app.ts');
const { loadConfig } = await import('../../services/api/src/config.ts');
const { createPool } = await import('../../services/api/src/db/pool.ts');
const { discoverMigrations, applyMigrations } = await import('../../services/api/src/db/migrate.ts');
const { hashToken, mintOpaqueToken, sha256Hex } = await import('../../services/api/src/auth/tokens.ts');
// 真表播种用的域内原语（与生产装配**同一份实现**，列名/约束/摘要口径不另抄一份）。
const { postModerationText } = await import('../../services/api/src/community/service.ts');
const { createPostgresCommunityStore } = await import('../../services/api/src/community/store-pg.ts');
const { createPostgresRecognitionStore } = await import('../../services/api/src/recognitions/store-pg.ts');
const { createPostgresOcrStore } = await import('../../services/api/src/ocr/store-pg.ts');
const { createPostgresSpeechStore } = await import('../../services/api/src/speech/store-pg.ts');
// 媒体真端口装配：与生产入口**同一份** resolver（`media/real-ports.ts:195` 的 `resolveMediaRealPorts`
// 是唯一铸造批准能力的入口），本臂只「显式接线 + 合成端点」，不碰真实桶、不发包。
const { MEDIA_REAL_WIRING_FLAG, resolveMediaRealPorts, mediaRealPortsAssemblyOptions } =
  await import('../../services/api/src/media/real-ports.ts');
const { readObjectStorageConfig } = await import('../../services/api/src/media/object-store.ts');
const { RULE_VERSION } = await import('../../packages/moderation/rule-version.mjs');
const { missingContractFields } = await import('../../packages/moderation/review.mjs');

/**
 * 本臂**已接**的作业过滤腿（`cases.mjs` 里 `app: 'jobs'` 的 9 条，S-6）。
 * ⛔ 不再按 `c.app === 'jobs'` 一刀切跳过：真库读面是 `createPostgresAdminJobPort`
 * （`services/api/src/app.ts:1380-1382` 在 real + 有池时装配），读的是四张域内作业表
 * （`ocr_jobs` / `recognition_jobs` / `speech_jobs` / `conversation_turns`），裸 SQL 即可播种
 * （种子见 `seedFailClosedRowsReal` 末尾 S8）。其余 `app: 'jobs'` 腿（当前不存在）仍保持「未取得」。
 */
const JOB_FILTER_LEGS = new Set(['C3-28', 'C3-29', 'C3-30', 'C3-31', 'C3-32', 'C3-33', 'C3-34', 'C3-35', 'C3-36']);

/** 作业过滤腿的种子 id：与 `cases.mjs:52` 的 `jobId(ordinal)` 逐字同式（末 12 位 = 11 个 0 + 序号）。 */
const jobSeedId = (ordinal) => `00000000-0000-4000-8d00-00000000000${ordinal}`;

// ---------------------------------------------------------------------------
// C2 媒体族的**合成**对象存储（⛔ 不读 ambient env、不读凭据文件、不发任何外呼）
// ---------------------------------------------------------------------------
/**
 * 端点用 RFC 6761 保留域 `.example.test`（DNS 永不解析，也没人能把它注册走），AK/SK 是明显合成串。
 *
 * 为什么不是「没配桶就继续跳过」：C2-01/02/03 是 NC-09 变异的**唯一**检出点
 * （`tests/failmatrix/README.md:122`：删 `media/service.ts` 的属主判断 ⇒ C2-01、C2-02 跨主体读媒体变
 * 200 泄露），而真库臂原先因为**装配层没注入批准能力**整域 503 ⇒ 媒体域的安全断言在这一臂上是空的。
 *
 * 会不会真发包：不会。上传只做**本地 SigV4 预签名**（`media/object-store.ts` 的 `presignUpload` 不
 * `fetch`）；对象存储适配器唯一的 `fetch` 点是 `send()`，而 C2 这 6 条都在碰字节之前就返回 404
 * （`getMedia` 只读元数据；`deleteMedia` 的 `dropObjects` 在属主 / `If-Match` 判定之后；
 * `grantMediaAccess` 同理）。另有两道绊线：装配后与整臂结束后都断言外呼计数为 0，且
 * `globalThis.fetch` 被换成会抛的绊线（见下）。
 *
 * ⚠ 口径不一致（既有，非本片引入，⛔ 不得据此宣称「媒体已持久化接线」）：批准串的 `persistence` 被
 * `real-ports.ts:149-154` 硬钉成 `process_memory`，而 `app.ts` 在有池时用 `createPostgresMediaStore`
 * 落库 ⇒ 批准的是**端口形态**（`s3_compatible` + 显式批准能力），不是持久化层。
 */
const SYNTHETIC_STORAGE_ENV = {
  OBJECT_STORAGE_ENDPOINT: 'https://storage.example.test',
  OBJECT_STORAGE_BUCKET: 'gy-media',
  OBJECT_STORAGE_ACCESS_KEY: 'AKIDSYNTHETICONLYR82ARM',
  OBJECT_STORAGE_SECRET_KEY: 'r82-synthetic-not-a-credential',
  OBJECT_STORAGE_REGION: 'ap-shanghai',
  OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
};
/** 访问凭据的签发原点：`real-ports.ts:214` 要求「可部署」（https、非 localhost、非 `.example` 顶级域）。 */
const SYNTHETIC_MEDIA_GRANT_ORIGIN = 'https://media.example.test';

/**
 * 外呼绊线：把 `globalThis.fetch` 换掉，任何一次调用都**记录下来并抛出**。
 * 判据是「一次都不许有」——本臂是离线的，真发出去就说明夹具漏了隔离
 * （先例：`tests/unit/i11-real-media-wiring.test.mjs:150-158`）。
 */
const fetchCalls = [];
globalThis.fetch = (...args) => {
  const target = String(args[0]);
  fetchCalls.push(target);
  throw new Error(`真库臂禁止外呼，但发生了 fetch：${target}`);
};

// ---------------------------------------------------------------------------
// 一次性 PG 17 集群
// ---------------------------------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
function runTool(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
/** ⛔ `pg_ctl` 绝不能给管道（派生守护进程会继承句柄挂死父进程），一律 stdio: 'ignore'。 */
function runDetached(bin, args) {
  execFileSync(bin, args, { stdio: 'ignore' });
}
async function waitForReady(connectionString, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const probe = new pg.Client({ connectionString, connectionTimeoutMillis: 1000 });
    try {
      await probe.connect();
      await probe.query('SELECT 1');
      await probe.end();
      return;
    } catch (error) {
      lastError = error;
      await probe.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`pg_ctl start 后 ${timeoutMs} ms 内连不上 ${connectionString}：${lastError?.message ?? 'unknown'}`);
}
/**
 * 停止并删除本脚本自己起的一次性集群目录。⛔ 只删「本脚本 initdb 出来的、目录名带固定前缀」的目录，
 * 且先 `pg_ctl stop` 再等 `postmaster.pid` 消失再删（与 `admin-audit-logs-pg.mjs` 的 `stopCluster` 同一口径）。
 * 该目录是 initdb 现造的空目录，不含任何 junction/symlink，递归删不会穿联结。
 */
async function stopAndRemoveCluster(dataDir) {
  const prefix = 'gy-i22-failmatrix-realpg-';
  if (!path.basename(dataDir).startsWith(prefix)) {
    throw new Error(`拒绝删除非本脚本创建的目录：${dataDir}`);
  }
  if (existsSync(path.join(dataDir, 'PG_VERSION'))) {
    runDetached(TOOL('pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', '-t', '60', 'stop']);
  }
  // `pg_ctl -w stop` 返回 ≠ postgres 已经放开文件句柄：等 postmaster.pid 消失再删目录。
  for (let wait = 0; wait < 100; wait += 1) {
    if (!existsSync(path.join(dataDir, 'postmaster.pid'))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`临时集群目录未能删除（句柄滞留）：${dataDir}`);
}

// ---------------------------------------------------------------------------
// 世界装配（real 模式 + 真 PG pool，不注入任何内存 store）
// ---------------------------------------------------------------------------
/** 真 PG 世界的身份播种：PG auth store 要求 subject 是合法 hex（decode($1,'hex')），内存 store 无此约束。 */
function hexSubject(label) {
  return createHash('sha256').update(`gy-i22-failmatrix-realpg-${label}`).digest('hex');
}

async function createAccount(world, label, options = {}) {
  const user = await world.auth.createUser(hexSubject(label));
  const token = mintOpaqueToken();
  const session = await world.auth.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: options.authEpoch ?? user.authEpoch,
    // 缺省过期时间取「库内 now() + 48h」：`created_at` 是列的 `DEFAULT now()`，两者同源才永远满足
    // `CHECK (expires_at > created_at)`（详见 main() 里 dbNowMs 的注释）。
    expiresAt: new Date(options.expiresAt ?? world.dbNowMs + 48 * 3600_000),
    audience: 'user',
  });
  return { kind: 'user', user, userId: user.id, token, session };
}

async function createAdmin(world, scopes, label = 'admin') {
  const adminId = await world.auth.createAdmin({
    loginName: `i22-realpg-${label}-${randomBytes(4).toString('hex')}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes,
  });
  const token = mintOpaqueToken();
  await world.auth.createSession({
    userId: adminId,
    tokenHashHex: hashToken(token),
    authEpoch: 1,
    // 同 createAccount：以库内 now() 为基准，否则 `admin_sessions` 的
    // `CHECK (expires_at > created_at)` 同样会被冻结时钟撞穿。
    expiresAt: new Date(world.dbNowMs + 3600_000),
    audience: 'admin',
  });
  return { kind: 'admin', userId: adminId, token, scopes };
}

const ALL_SCOPES = [
  'sources:read',
  'sources:write',
  'accounts:read',
  'accounts:suspend',
  'jobs:read',
  'jobs:cancel',
  'flags:read',
  'flags:write',
  'audit:read',
  'session:read',
  'session:logout',
];

/**
 * 不可播种夹具的哨兵：任何读取（属性访问 / 模板字符串拼接）都会抛带原因的错，
 * 由跑用例前的解析 try/catch 捕获 ⇒ 该用例标 `not-runnable`，⛔ 不拿 null 拼出误导性读数。
 */
function unavailableSeed(domain) {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
        throw new Error(`夹具不可用：${domain} 在 real 模式 fail-closed，无法播种`);
      }
      throw new Error(`夹具不可用：${domain} 在 real 模式 fail-closed，无法播种`);
    },
  });
}

/**
 * 「本该播出来、这次没播成」的哨兵（与 `unavailableSeed` 的差别只在**措辞**，因为根因不同：
 * 那一类是域被 real 模式关掉，这一类是播种这一步失败/没拿到 id）。同样一碰就抛 ⇒ 依赖它的用例
 * 在解析路径时抛 ⇒ 落 `not-runnable`，⛔ 不会拼出 `…/turns/null` 这种被 `format: 'uuid'` 挡成
 * 400 INVALID_REQUEST 的**假读数**（看起来像一条正常的越权拒绝，实际什么都没验到）。
 */
function missingSeed(what) {
  const message = `夹具未取得：${what} —— 播种没拿到 id（真因见日志里的 [seed] 告警）；⛔ 不用 null 拼路径。`;
  return new Proxy({}, {
    get() {
      throw new Error(message);
    },
  });
}

/**
 * 真 PG 世界的属主行播种（B 的私有行）。
 * 能播的播（收藏 / 历史 / 消息 / 会话，走 HTTP 或服务原语）；real 模式下 HTTP 写面 fail-closed 的那几组
 * （社区投稿 / 举报 / 作业 / 识别 / OCR / 转写）改为按**真表**在库里播种（见 `seedFailClosedRowsReal`）。
 * 任何一组播不上就**保留原 `unavailableSeed` 哨兵**并 `console.warn` 一行原因 ⇒ 对应用例继续 `not-runnable`，
 * ⛔ 不拿「不存在」当「越权 404」的假同形，也⛔ 不让整臂抛死。
 */
async function seedOwnerRowsReal(world, owner, { pool, attacker }) {
  const seeded = {
    // 媒体属主行见下方「媒体属主行」段：走服务原语 `initiateUpload` 播一条**真 `media` 行**（属主 = B）。
    // 播不上就保留会响的哨兵 ⇒ C2-01/02/03 继续如实 not-runnable（⛔ 不拿「不存在」冒充「越权 404」的假同形）。
    media: missingSeed('B 的媒体（app.mediaService.initiateUpload 播种失败）'),
    favoriteId: null,
    historyId: null,
    messageId: null,
    postId: unavailableSeed('社区投稿（审核管线未接线）'),
    commentId: unavailableSeed('社区投稿（审核管线未接线）'),
    reportId: unavailableSeed('社区举报（审核管线未接线）'),
    jobId: unavailableSeed('异步 AI 作业（需媒体 + 真实供应商）'),
    recognitionId: unavailableSeed('识别（需媒体 + 真实供应商）'),
    ocrId: unavailableSeed('OCR（需媒体 + 真实供应商）'),
    transcriptionId: unavailableSeed('转写（需媒体 + 真实供应商）'),
    hideTargetPostId: unavailableSeed('社区投稿（审核管线未接线，隐藏目标）'),
    // 缺陷 C-2：三个会话侧 id 用**会响的哨兵**而不是裸 `null`。`?? null` 会把路径拼成
    // `/conversations/null/turns/null`，被 `routes/conversations.ts:60`/`:67` 的 `format: 'uuid'`
    // 挡成 400 INVALID_REQUEST —— 读数看着像一条正常的越权拒绝，实际一条判据都没验到。
    conversationId: missingSeed('B 的会话（POST /conversations）'),
    conversationEtag: missingSeed('B 的会话 ETag（GET /conversations/:id）'),
    turnId: missingSeed('B 的会话轮次（POST /conversations/:id/turns）'),
  };

  // 收藏：走 HTTP（与 stub 同一路径），真 PG favorites store 落库。
  try {
    const favorite = await inject(world.app, {
      method: 'POST',
      path: `${API}/favorites`,
      actor: owner,
      body: { target_ref: { type: 'species', id: SPECIES_ID, revision: 1 } },
      headers: { 'idempotency-key': 'i22-realpg-seed-fav' },
    });
    if (favorite.status === 201) seeded.favoriteId = favorite.body?.data?.id ?? null;
  } catch {
    /* 收藏域在真 PG 下不可播 ⇒ 保持 null */
  }

  // 历史 / 消息：走服务原语（与 stub seedOwnerRows 同一调用），真 PG store 落库。
  try {
    const history = await world.app.historyService.appendHistory({
      owner_id: owner.userId,
      kind: 'recognition',
      target_ref: { type: 'recognition', id: '00000000-0000-4000-8a00-0000000000b1', revision: 1 },
      job_id: '00000000-0000-4000-8b00-0000000000b1',
      job_state: 'succeeded',
      event_key: 'i22-realpg-seed-hist',
    });
    seeded.historyId = history.history?.id ?? null;
  } catch {
    /* 历史域不可播 */
  }
  try {
    const message = await world.app.messagesService.appendMessage({
      owner_id: owner.userId,
      type: 'comment',
      target_ref: null,
      event_key: 'i22-realpg-seed-msg',
    });
    seeded.messageId = message.message?.id ?? null;
  } catch {
    /* 消息域不可播 */
  }

  // 会话：走 HTTP（真 PG conversations store）。
  // 缺陷 C-2：这里**逐跳验状态码与 data.id**，失败就 `warnSeed` 响一声（原先整块 `catch {}` 静默吞错，
  // 播种失败在日志里零痕迹，只在下游拼出 `…/turns/null` 的假 400）。id 没拿到时哨兵继续兜底。
  try {
    const conversation = await inject(world.app, {
      method: 'POST',
      path: `${API}/conversations`,
      actor: owner,
      body: {},
      headers: { 'idempotency-key': 'i22-realpg-seed-conv' },
    });
    if (conversation.status !== 201) {
      throw new Error(`POST /conversations 期望 201 实际 ${conversation.status}：${conversation.text}`);
    }
    const conversationId = conversation.body?.data?.id;
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      throw new Error(`POST /conversations 响应缺 data.id：${conversation.text}`);
    }
    seeded.conversationId = conversationId;
    const read = await inject(world.app, { method: 'GET', path: `${API}/conversations/${conversationId}`, actor: owner });
    const etag = read.etag ?? `"${conversation.body?.data?.revision}"`;
    seeded.conversationEtag = etag;
    const turn = await inject(world.app, {
      method: 'POST',
      path: `${API}/conversations/${conversationId}/turns`,
      actor: owner,
      body: { input_type: 'text', text: '真 PG 臂合成提问：稻田稗草三到五叶期该用什么药？' },
      headers: { 'idempotency-key': 'i22-realpg-seed-turn', 'if-match': etag },
    });
    // `routes/conversations.ts:186` 该路由的成功码是 **202**（作业受理），不是 201。
    if (turn.status !== 202) {
      throw new Error(`POST /conversations/:id/turns 期望 202 实际 ${turn.status}：${turn.text}`);
    }
    const turnId = turn.body?.data?.id;
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new Error(`POST /conversations/:id/turns 响应缺 data.id：${turn.text}`);
    }
    seeded.turnId = turnId;
  } catch (error) {
    warnSeed('会话 / 会话轮次（C11-25…C11-39 的 B 侧夹具）', error);
  }

  // 媒体属主行（C2-01/02/03 的 B 侧夹具 = C2-11/12/13 的 `sameShapeAs` 对照组）。
  // 走**服务原语**而不是 HTTP：`POST /media/uploads` 要过 `media_processing` 同意门
  // （`routes/media.ts` 的 consent 检查），而本臂刻意只给攻击者 a 播同意行 ⇒ 属主 b 会被 409/403 挡住。
  // ⚠ `purpose` 必须避开 `community_image`：那条会撞「每帖 ≤3 张」的**未接线**计数口 ⇒ 503
  // （`media/service.ts:840-856`），本族不依赖它。`weed_recognition` 只要求 image/png + ≤2MiB。
  // 全程无外呼：`initiateUpload` 只在本进程算 SigV4 预签名，不取上传字节。
  try {
    const upload = await world.app.mediaService.initiateUpload({
      actor: { ownerId: owner.userId, authEpoch: owner.user.authEpoch, sessionRef: 'mx-real-media-seed' },
      input: { purpose: 'weed_recognition', mime: 'image/png', bytes: 1024, sha256: 'b'.repeat(64) },
      idempotencyKey: 'i22-realpg-seed-media',
    });
    if (upload.status !== 201) throw new Error(`initiateUpload 期望 201 实际 ${upload.status}`);
    const mediaId = upload.media?.id;
    const revision = upload.media?.revision;
    if (typeof mediaId !== 'string' || mediaId === '') throw new Error('initiateUpload 响应缺 media.id');
    if (typeof revision !== 'number') throw new Error('initiateUpload 响应缺 media.revision');
    seeded.media = { mediaId, revision };
    console.log(`[pg] media_seed=${mediaId} revision=${revision}（属主 B，state=initiated，未上传字节）`);
  } catch (error) {
    warnSeed('媒体属主行（C2-01/02/03 的 B 侧夹具；C2-11/12/13 的对照组）', error);
  }

  // 社区 / 异步 AI 两族：real 模式下没有 HTTP 写路径，直接按迁移定义的真表播种。
  await seedFailClosedRowsReal({ pool, world, owner, attacker, seeded });

  return seeded;
}

/** 播种失败只 warn 一行（⛔ 不抛死整臂、⛔ 不静默当成功）。 */
function warnSeed(group, error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[seed] ${group}播种失败，保留原哨兵（该组用例继续 not-runnable）：${reason}`);
}

/**
 * real 模式 fail-closed 的两族属主行，按**真表**播种（迁移 0022 / 0024–0026）：
 *   - 社区：`community_posts` / `community_comments` / `community_reports` /
 *     `community_moderation_decisions`（0022）
 *   - 异步 AI：`recognition_jobs` / `recognition_records`（0025）、`ocr_records`（0024）、
 *     `transcriptions`（0026）
 * 之所以不走 HTTP：`createPost` 先过审核闸（real 审核 fail-closed ⇒ 503），
 * `POST /recognitions|/ocr|/speech/transcriptions` 需要真实供应商与就绪媒体（⇒ 503）。
 * ⛔ 不播 `posts`/`comments`/`reports`（0001，与本臂无关），也⛔ 不播 `public.jobs`
 *   （`services/api/src` 零引用，播了没人读）。列名/约束一律照迁移，摘要与结论口径一律复用域内实现。
 */
async function seedFailClosedRowsReal({ pool, world, owner, attacker, seeded }) {
  const at = new Date(world.dbNowMs);
  const atIso = at.toISOString();
  // 小写 uuid 形态：社区域 UUID_PATTERN 无 i 标志（community/validate.ts:36）。
  const fixtureId = (n) => `00000000-0000-4000-9d00-${String(n).padStart(12, '0')}`;
  const mediaId = fixtureId(50);
  const ids = {
    post: fixtureId(1),
    comment: fixtureId(2),
    report: fixtureId(3),
    hideTarget: fixtureId(4),
    job: fixtureId(21),
    recognition: fixtureId(22),
    ocr: fixtureId(31),
    transcription: fixtureId(41),
  };

  /** 让帖/评论在 `effectiveState` 里被判成 `approved` 的台账行（service.ts:583-616 + moderation-gate.ts:218-267）。 */
  const verdictOf = (kind, targetId, revision, text, n) => ({
    id: fixtureId(n),
    target_ref: { type: kind, id: targetId, revision },
    decision: 'approved',
    reason_codes: [],
    hard_rule_passed: true,
    rule_version: RULE_VERSION,
    text_digest: sha256Hex(text),
    contract_complete: false,
    missing_contract_fields: missingContractFields(),
    decided_by: null,
    created_at: atIso,
  });

  // ---- S0 授权行（攻击者 a）------------------------------------------------
  // consent 闸只在真池时接上（app.ts:995-999），闸读的是 privacy_epochs + consent_records 这对表
  // （consent-pg.ts:46-48 的 LEFT JOIN）；被闸住的是 C2-08/C2-09（public_posting）、
  // C11-07（weed_recognition）、C11-13/15（label_ocr）、C11-21（voice_question）。
  // ⛔ 不走 `POST /me/consents`：那条路要求现行 policy 与已登记的 verified recipient。
  // ⛔ 不给属主 b 播：b 命中的都是无闸的 GET/DELETE，多播只会扩大翻转面。
  try {
    for (const purpose of ['public_posting', 'media_processing', 'external_inference', 'recording']) {
      await pool.query(
        `INSERT INTO public.privacy_epochs (user_id, purpose, current_epoch, state)
         VALUES ($1::uuid, $2::consent_purpose, 1, 'granted')
         ON CONFLICT (user_id, purpose)
         DO UPDATE SET current_epoch = 1, state = 'granted',
                       revision = public.privacy_epochs.revision + 1, updated_at = now()`,
        [attacker.userId, purpose],
      );
      await pool.query(
        `INSERT INTO public.consent_records (user_id, purpose, policy_version, recipient_ids, state, epoch, granted_at, withdrawn_at)
         VALUES ($1::uuid, $2::consent_purpose, 'i22-realpg-fixture-v1', '[]'::jsonb, 'granted', 1, now(), NULL)
         ON CONFLICT (user_id, purpose, epoch)
         DO UPDATE SET state = 'granted', withdrawn_at = NULL, granted_at = now()`,
        [attacker.userId, purpose],
      );
    }
  } catch (error) {
    warnSeed('授权行（C2-08/C2-09/C11-07/C11-13/C11-15/C11-21）', error);
  }

  // ---- S1–S4 社区 ---------------------------------------------------------
  let community = null;
  try {
    community = createPostgresCommunityStore({ pool });
  } catch (error) {
    warnSeed('社区 store 装配（C2/C3 社区组）', error);
  }

  let postReady = false;
  if (community !== null) {
    try {
      const title = '真 PG 臂种子的属主 B 帖子（跨账号越权矩阵用）';
      const body = '这是属主 B 的帖子正文：用于判定他人读、改、删是否被正确拒绝。';
      const record = {
        id: ids.post,
        revision: 1,
        author_id: owner.userId,
        anonymized_author_ref: null,
        title,
        body,
        crop_id: null,
        region_code: null,
        media_ids: [],
        linked_knowledge_ref: null,
        visibility: 'published',
        audit_state: 'approved',
        created_at: atIso,
        updated_at: atIso,
      };
      const inserted = await community.insertPost(record, verdictOf('post', ids.post, 1, postModerationText(record), 11));
      if (inserted !== true) {
        // insertPost 在 id 已存在时返回 false 且不写台账行 ⇒ 回读确认行确实在，否则当失败。
        if ((await community.getPost(ids.post)) === null) throw new Error('community_posts 未落行');
      }
      seeded.postId = ids.post;
      postReady = true;
    } catch (error) {
      warnSeed('社区帖（C2-07/C2-10/C2-19/C3-07/C3-13/C3-18）', error);
    }
  }

  if (community !== null && postReady) {
    try {
      const record = {
        id: ids.comment,
        revision: 1,
        post_id: ids.post,
        author_id: owner.userId,
        anonymized_author_ref: null,
        body: '这是属主 B 的评论正文：用于判定他人改、删是否被正确拒绝。',
        visibility: 'published',
        audit_state: 'approved',
        created_at: atIso,
      };
      // commentModerationText 不导出（service.ts:229-231 返回 record.body），摘要逐字镜像它。
      const inserted = await community.insertComment(
        record,
        verdictOf('comment', ids.comment, 1, record.body, 12),
        { id: ids.post, revision: 1 },
      );
      if (inserted !== true) throw new Error('community_comments 未落行');
      seeded.commentId = ids.comment;
    } catch (error) {
      warnSeed('社区评论（C2-09）', error);
    }
    try {
      await community.insertReport({
        id: ids.report,
        revision: 1,
        reporter_id: owner.userId,
        target_ref: { type: 'post', id: ids.post, revision: 1 },
        state: 'received',
        reason_code: 'other',
        detail: '属主 B 的举报细节（真 PG 臂种子）',
        anonymized_author_ref: null,
        created_at: atIso,
      });
      seeded.reportId = ids.report;
    } catch (error) {
      warnSeed('社区举报（C2-20）', error);
    }
    // S4：隐藏目标必须是**另一条**帖（cases.mjs:182 的 note），否则 C3-25/C3-27 会与 C2-19 互相污染。
    try {
      const title = '真 PG 臂种子的隐藏目标帖（C3-25/C3-27 用）';
      const body = '这是另一条属主 B 的帖子：只用于验证后台隐藏与隐藏后不可见。';
      const record = {
        id: ids.hideTarget,
        revision: 1,
        author_id: owner.userId,
        anonymized_author_ref: null,
        title,
        body,
        crop_id: null,
        region_code: null,
        media_ids: [],
        linked_knowledge_ref: null,
        visibility: 'published',
        audit_state: 'approved',
        created_at: atIso,
        updated_at: atIso,
      };
      const inserted = await community.insertPost(
        record,
        verdictOf('post', ids.hideTarget, 1, postModerationText(record), 13),
      );
      if (inserted !== true) {
        if ((await community.getPost(ids.hideTarget)) === null) throw new Error('community_posts 未落行');
      }
      seeded.hideTargetPostId = ids.hideTarget;
    } catch (error) {
      warnSeed('隐藏目标帖（C3-25/C3-27）', error);
    }
  }

  // ---- S5–S7 异步 AI -----------------------------------------------------
  // 三张记录表对 media **无外键**（0024:110-126 / 0025:131-151 / 0026:112-130 的 media_id 只是 uuid），
  // 所以不需要媒体行或对象存储；作业表挂在 owner_user_id 上（0025:103-123）。
  try {
    const recognition = createPostgresRecognitionStore({ pool });
    await recognition.insertJob({
      id: ids.job,
      revision: 1,
      kind: 'recognition',
      ownerUserId: owner.userId,
      recognitionId: ids.recognition,
      mediaId,
      mediaRevision: 1,
      // queued ⇒ toJob 的 usable 为假、result 为 null（recognitions/service.ts:260-273），不触发结果深校验。
      state: 'queued',
      deadlineAt: new Date(at.getTime() + 30_000),
      createdAt: at,
      updatedAt: at,
      errorCode: null,
    });
    await recognition.insertRecognition({
      id: ids.recognition,
      revision: 1,
      ownerUserId: owner.userId,
      mediaId,
      mediaRevision: 1,
      candidates: [{ species_id: SPECIES_ID, rank: 1, model_score: 0.91 }],
      uncertaintyReasons: [],
      selectedSpeciesId: null,
      modelVersion: 'i22-realpg-fixture-v1',
      createdAt: at,
      updatedAt: at,
      deleted: false,
    });
    seeded.jobId = ids.job;
    seeded.recognitionId = ids.recognition;
  } catch (error) {
    warnSeed('识别作业与识别记录（C11-01/C11-03/C11-05/C11-07/C11-09/C11-35/C11-36）', error);
  }

  try {
    const ocr = createPostgresOcrStore({ pool });
    // ingredients 每项必须 name/content_text/unit_text 三个非空文本，否则读回时 503（ocr/store-pg.ts:233-256）。
    const fields = {
      registration_number: 'PD20210001',
      name: '替身示例草甘膦水剂',
      ingredients: [{ name: '草甘膦', content_text: '41', unit_text: '%' }],
      dosage_form: '水剂',
    };
    await ocr.insertOcr({
      id: ids.ocr,
      revision: 1,
      ownerUserId: owner.userId,
      mediaId,
      mediaRevision: 1,
      rawFields: fields,
      correctedFields: fields,
      verification: { match_state: 'no_match', registration: null, conflict_fields: [], missing_fields: [], dose_cards: [] },
      modelVersion: 'i22-realpg-fixture-v1',
      createdAt: at,
      updatedAt: at,
      deleted: false,
    });
    seeded.ocrId = ids.ocr;
  } catch (error) {
    warnSeed('OCR 记录（C11-11/C11-13/C11-15/C11-17/C11-37）', error);
  }

  try {
    const speech = createPostgresSpeechStore({ pool });
    await speech.insertTranscription({
      id: ids.transcription,
      revision: 1,
      ownerUserId: owner.userId,
      mediaId,
      mediaRevision: 1,
      rawText: '真 PG 臂合成转写：稻田稗草三到五叶期用药建议（非真实录音内容）。',
      uncertainSpans: [],
      confirmedText: null,
      confirmedAt: null,
      modelVersion: 'i22-realpg-fixture-v1',
      createdAt: at,
      updatedAt: at,
      deleted: false,
    });
    seeded.transcriptionId = ids.transcription;
  } catch (error) {
    warnSeed('转写记录（C11-19/C11-21/C11-23/C11-38）', error);
  }

  // ---- S8 作业过滤腿（C3-28…C3-36）的读面种子 -------------------------------
  // ⚠️ 这 6 行是**合成播种的真实真库行**（直接 INSERT 进 `public.ocr_jobs`，迁移 0024:80-101），
  // 不是产品数据、不是生产样本：只为让 `/admin/jobs` 的四源读面（`admin/ops/jobs-pg.ts` 的 `SOURCES`）
  // 有确定的行可读、可过滤、可翻页。real 模式下没有 `POST /ocr` 这条写路径（供应商未接线 ⇒ 503），
  // 裸 SQL 是唯一播法，播完仍走**生产同一份**读实现。
  //   - `id` 用 `cases.mjs:52` 的 `jobId(n)` 同式（末 12 位 = 11 个 0 + 序号）：C3-31/C3-33/C3-36 按 id 断言；
  //   - `state` 与 `world.mjs:298-305` 的 `ADMIN_JOB_SEED` **同值同序**（stub 臂的固定种子），
  //     这样「同一矩阵」在真库上过滤的是同一组状态；
  //   - `created_at = now() + n 秒`：读面排序是 `ORDER BY j.created_at DESC, j.id DESC`（jobs-pg.ts 的
  //     `listTail`），取未来时刻让 6 行先后**只由序号决定**、不受播种时刻与同秒并列影响
  //     ⇒ C3-31 首页稳定落在 #2（queued 里较新）、C3-33 页 2 稳定落在 #1；
  //   - `ocr_id` / `media_id` 无外键（0024:88-90 明文：记录由 commitTerminal 后落，先建任务后产记录是正常时序）
  //     ⇒ 合成 uuid 即可；`media_revision` 照 CHECK 取 1；
  //   - `owner_user_id` 是本表唯一有外键的列（0024:87 → `public.users`），挂属主 b。
  // ⚠️ 这 6 行**不是**该读面的全部：同一次播种还在 `recognition_jobs` 写了 S5 的 `ids.job`（queued），
  //   会话轮次一旦播成还会经 `jobs-pg.ts` 的 `ANSWER_SOURCE`（`public.conversation_turns`）再进一行
  //   ⇒ `/admin/jobs` 的行数在真库臂本来就不是 6。故 C3-35 的 `items.length === 6` 是 **stub 臂固定种子**
  //   的口径，在真库臂不成立：`verdictFor` 接上 `check` 之后它会红——那是读数（真库读面比 stub 种子多源），
  //   ⛔ 不许改断言、也不许按本臂实际行数把 6 放宽成 8 来凑绿。
  try {
    const ADMIN_JOB_SEED_STATES = [
      ['queued', null],
      ['queued', null],
      ['running', null],
      ['succeeded', null],
      ['failed', 'PROVIDER_TIMEOUT'],
      ['cancelled', null],
    ];
    for (const [index, [state, errorCode]] of ADMIN_JOB_SEED_STATES.entries()) {
      const ordinal = index + 1;
      await pool.query(
        `INSERT INTO public.ocr_jobs
           (id, revision, kind, owner_user_id, ocr_id, media_id, media_revision,
            state, error_code, created_at, deadline_at, updated_at)
         VALUES ($1::uuid, 1, 'ocr', $2::uuid, $3::uuid, $4::uuid, 1, $5::text, $6::varchar,
                 now() + ($7::integer * interval '1 second'),
                 now() + interval '1 hour',
                 now() + ($7::integer * interval '1 second'))`,
        [jobSeedId(ordinal), owner.userId, fixtureId(60 + ordinal), mediaId, state, errorCode, ordinal],
      );
    }
    seeded.jobFilterJobIds = ADMIN_JOB_SEED_STATES.map((_, index) => jobSeedId(index + 1));
    seeded.jobFilterSeedOk = true;
  } catch (error) {
    warnSeed('作业过滤腿种子（C3-28…C3-36）', error);
  }
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------
function codeOf(result) {
  return result.body?.error?.code ?? null;
}

/**
 * 逐条判定：`status` + `code` + **用例自带的 `check` 断言**（同构照搬 `run.mjs:374-377`）。
 *
 * ⛔ 旧版只比 status + code：全文件对 `c.check` / `c.sameShapeAs` 的引用是 0，于是 158 条 `same` 里
 * 有 44 条（`sameWithCheck` 19 + `sameWithShape` 25）携带的断言**一条都没执行**——其中包括 C3-28…C3-36
 * 九条作业腿的全部判据（C3-35 的 `expect` 只有 `{status:200}`，判据全在 `check`；C3-32 的
 * 「集合已变化，请重新开始分页」措辞也没验）。`same` 必须意味着「该条携带的断言真跑过且全过」，
 * 否则读数只是状态码级，不能当证据。
 *
 * 三段判据分开记，`different` 才能归因：
 *   - `problems`       status / code / `meta.execution_mode`（stub 期望 vs 真 PG 实际）
 *   - `checkProblems`  用例自带的 `check`（调用方式与 `run.mjs` 一致：`c.concurrent === undefined` 传单条结果）
 *   - `shapeProblems`  同形对照组（**后置** pass，见 `shapePostPass`：对照组可能排在本条之后）
 */
function verdictFor(c, result, ctx) {
  const exp = c.expect ?? {};
  const actualCode = codeOf(result);
  const problems = [];
  const checkProblems = [];
  if (exp.status !== undefined && result.status !== exp.status) {
    problems.push(`status stub期望 ${exp.status} 实际 ${result.status}`);
  }
  if (exp.code !== undefined && actualCode !== exp.code) {
    problems.push(`code stub期望 ${exp.code} 实际 ${actualCode ?? '-'}`);
  }
  const metaMode = result.body?.meta?.execution_mode;
  if (metaMode !== 'real') {
    problems.push(`meta.execution_mode 期望 real 实际 ${JSON.stringify(metaMode ?? null)}`);
  }
  let checkRan = false;
  if (typeof c.check === 'function') {
    checkRan = true;
    let extra;
    try {
      extra = c.concurrent === undefined ? c.check(result, ctx) : c.check(ctx.results, ctx);
    } catch (error) {
      // 断言自己抛错（多因夹具哨兵被读）⇒ 是真问题，不静默当通过。
      checkProblems.push(`check 抛错：${error?.message ?? error}`);
      extra = null;
    }
    if (Array.isArray(extra)) checkProblems.push(...extra);
    else if (extra !== null) checkProblems.push(`check 返回值不是数组（${typeof extra}）⇒ 断言无法判定`);
  }
  const same = problems.length === 0 && checkProblems.length === 0;
  return { same, problems, checkProblems, checkRan, metaMode };
}

/**
 * 「整域不可用」的两种形态（缺陷 B 的分流口径）：同一根因不该一半进 `not-runnable`、一半进 `different`。
 *
 *   1. `503 PROVIDER_UNAVAILABLE`：整域 fail-closed。媒体域的真原因是缺 `isRealMediaWiringApproved`
 *      铸造的批准能力（`services/api/src/media/service.ts:603-616`），**不是**缺 `MEDIA_OBJECT_REF_KEY`
 *      ——本臂已给 `'a'.repeat(64)`，`app.ts:1807-1810` 的 mediaPersistenceRefusal 不触发；
 *      审计事件读面（`GET /admin/audit-events`）同理未接线（`admin/fail-closed-services.ts` 的 `reject`）。
 *      ⚠ **注销受理不属于这一类**（本注释 2026-10-30 前的口径已过期）：`app.ts:2339` 逐字
 *      `available: config.executionMode !== 'real' || deletionAcceptanceDurable`，而
 *      `deletionAcceptanceDurable`（`app.ts:2332-2333`）在 real + 真库下为真 ⇒ 受理是**开着**的
 *      （`app.ts:2314-2319`：real 下唯一保留的 503 是「real 但无真库」）。C4-15 在真库臂真拿到 202 即证。
 *   2. `409 OBJECT_UNAVAILABLE` 且 `details[0].field === 'feature_flag'`：全局开关关闭
 *      （`services/api/src/admin/ops/flag-gate.ts:418-422` 的 `closedError()`；`contract.ts:19` 定
 *      OBJECT_UNAVAILABLE = 409）。
 *
 * 两者都不是「本臂判据与真库不一致」，而是「该域在本臂没有可用实现 / 被开关整体关闭」⇒ 断言观察不到，
 * 如实记 `not-runnable` 并带可读 reason（含服务端原文 message）。⚠️ 只有 `status` + `code` + 形态三样都对上
 * 才改判，且原状（stub 期望 vs 实际）留在 `entry.actual` / `entry.reclassifiedFrom` 里，不吞差异。
 */
function domainUnavailable(result) {
  const error = result.body?.error ?? {};
  const details = Array.isArray(error.details) ? error.details : [];
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : '（服务端未给 message）';
  if (result.status === 503 && error.code === 'PROVIDER_UNAVAILABLE') {
    return `整域不可用（real 模式该域 fail-closed）：503 PROVIDER_UNAVAILABLE —— ${message}`;
  }
  if (result.status === 409 && error.code === 'OBJECT_UNAVAILABLE' && details[0]?.field === 'feature_flag') {
    // 开关键名不一定在 `details` 里（`closedError()` 把它写在 message 的 `（key=false）` 里）⇒ 两处都试，取到就报。
    const fromMessage = /（([a-z_]+)=false）/.exec(message)?.[1];
    const flag = details[0]?.value ?? details[0]?.flag ?? fromMessage ?? 'unknown';
    return `整域不可用（全局开关关闭 feature_flag=${flag}）：409 OBJECT_UNAVAILABLE —— ${message}`;
  }
  return null;
}

/**
 * `sameShapeAs` 后置比对（同构照搬 `run.mjs:386-402`）：对照组可能排在本条之后，故全部用例跑完再比。
 * 形状指纹用 `world.mjs:202-211` 的 `envelopeShape`（抹掉 `request_id` / `message` 后逐字节可比）。
 * 对照组本次没取得读数（它自己 `not-runnable`）时**不算通过**：标 `unavailable` 并在汇总里单列，
 * ⛔ 不把「没比」伪装成「形状一致」。
 */
function shapePostPass(rows, ctx) {
  const byId = new Map(CASES.map((c) => [c.id, c]));
  const counts = { compared: 0, mismatched: 0, unavailable: 0 };
  for (const row of rows) {
    const other = byId.get(row.id)?.sameShapeAs;
    if (other === undefined) continue;
    const mine = ctx.results.get(row.id);
    const twin = ctx.results.get(other);
    const twinSingle = Array.isArray(twin) ? twin[0] : twin;
    if (mine === undefined || twinSingle === undefined) {
      row.shape = {
        twin: other,
        state: 'unavailable',
        reason: `同形对照组 ${other} 本次没取得读数（该条 not-runnable），同形比对未执行`,
      };
      row.assertions.shape = 'unavailable';
      counts.unavailable += 1;
      continue;
    }
    const mineShape = envelopeShape(mine);
    const theirsShape = envelopeShape(twinSingle);
    row.assertions.shape = 'compared';
    if (mineShape === theirsShape) {
      row.shape = { twin: other, state: 'same' };
      counts.compared += 1;
      continue;
    }
    row.shape = { twin: other, state: 'different' };
    row.shapeProblems = [`同形对照组 ${other} 形状不同：本条 ${mineShape} ／ 对照组 ${theirsShape}`];
    counts.compared += 1;
    counts.mismatched += 1;
    // 形状不一致就是真差异（越权 404 与「本来不存在」404 必须同形，否则泄露存在性）。
    if (row.verdict === 'same') {
      row.verdict = 'different';
      row.reclassifiedFrom = row.reclassifiedFrom ?? 'same';
    }
  }
  return counts;
}

/**
 * 解析夹具/路径时抛错的原因措辞。
 * 哨兵自己已经写清了根因（`夹具不可用：…` / `夹具未取得：…`）时**不再**套一层
 * 「real 模式该域 fail-closed」——把「播种没成」说成「域被关」会把读表的人引向错误的修法。
 */
function fixtureReason(error) {
  const message = String(error?.message ?? error);
  if (message.startsWith('夹具不可用：') || message.startsWith('夹具未取得：')) return message;
  return `夹具不可用（real 模式该域 fail-closed）：${message}`;
}

/**
 * `not-runnable` 的原因分类（汇总用）：让「没跑到」的 N 条能按根因读，而不是一坨。
 * ⛔ 分类只用于读表，不改变任何一条的判定。
 */
function notRunnableKind(reason) {
  const text = reason ?? '';
  if (text.startsWith('夹具未取得')) return 'seed-missing';
  if (text.startsWith('夹具不可用')) return 'fixture';
  if (text.startsWith('整域不可用')) return 'domain-unavailable';
  if (text.startsWith('作业过滤腿')) return 'jobs-unseeded';
  if (text.startsWith('并发用例')) return 'concurrent';
  if (text.startsWith('inject 抛错')) return 'inject-error';
  return 'other';
}

/**
 * 缺陷 C-1：真库臂的**夹具前提**——把 `ai_enabled` 打开。
 *
 * 依据：`services/api/db/migrations/0020_feature_flags.sql:78-82` 以 `enabled=false` 播种三条开关，
 * 全仓没有任何迁移把它翻成 true；`services/api/src/admin/ops/flag-gate.ts` 的 `FLAG_GATED_SURFACES`
 * 把 `createTurn` / `createRecognition` / `createOCR` / `createTranscription` / `createSynthesis`
 * 挂在 `ai_enabled` 上，关着时一律 409 `OBJECT_UNAVAILABLE`（`details[0].field === 'feature_flag'`）。
 * 修前实测后果：B 的会话轮次播不出来（`seeded.turnId` 只能是 null）⇒ C11-33 拼出 `…/turns/null`
 * 拿到「看起来像正常拒绝」的假 400；C11-29/30 只剩 409 一条读数。
 *
 * 这里**只动夹具状态，不碰被测代码**：`createPortFlagReader` 的快照在每次进入受控路由时刷新
 * （`flag-gate.ts:166`、`prepare()`），故 UPDATE 之后的下一个请求就能看到，无需重启 app。
 * `revision` 一并 +1：真实写面 `public.set_feature_flag()` 每次真变更都会 +1，夹具照同一口径，
 * 免得「开了但 revision 还是 1」这种真库不可能出现的状态混进读数。
 */
async function armFeatureFlags(pool) {
  const result = await pool.query(
    `UPDATE public.feature_flags
        SET enabled = true, revision = revision + 1
      WHERE key = 'ai_enabled'
      RETURNING key, enabled, revision`,
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || row?.enabled !== true) {
    throw new Error(`夹具前提未成立：ai_enabled 没播成（rowCount=${result.rowCount}）`);
  }
  console.log(`[pg] 夹具开关 ai_enabled=true revision=${row.revision}（0020 播的是 false，全仓无迁移翻 true）`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--allow-skip') continue; // 已在闸门处消费
    if (arg.startsWith('--json=')) out.json = arg.slice('--json='.length);
    else if (arg === '--json') out.json = argv[++i] ?? '';
    else throw new Error(`未知参数：${arg}（只支持 --json= / --allow-skip）`);
  }
  return out;
}
const opts = parseArgs(process.argv.slice(2));

function baseCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: REPO_ROOT }).trim();
  } catch {
    return 'unknown';
  }
}

function resolveValue(value, ctx) {
  return typeof value === 'function' ? value(ctx) : value;
}

const PERMISSION_FAMILIES = new Set(['C1', 'C2', 'C3', 'C4', 'C10', 'C11']);
const selected = CASES.filter((c) => PERMISSION_FAMILIES.has(c.family));

async function main() {
  const rootDir = process.env.GY_I22_PG_ROOT ?? tmpdir();
  mkdirSync(rootDir, { recursive: true });
  const dataDir = path.join(rootDir, `gy-i22-failmatrix-realpg-${process.pid}-${randomBytes(4).toString('hex')}`);
  const logFile = path.join(rootDir, `gy-i22-failmatrix-realpg-${process.pid}-${randomBytes(4).toString('hex')}.log`);
  const keep = process.env.GY_I22_PG_KEEP === '1';
  const port = await freePort();
  const connectionString = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const startedAt = Date.now();

  let app = null;
  let pool = null;
  let owner = null;
  let clusterUp = false;
  let serverVersion = '';

  console.log(`[pg] bin=${binDir}`);
  console.log(`[pg] dataDir=${dataDir} port=${port}`);
  try {
    if (existsSync(dataDir)) throw new Error(`数据目录已存在，拒绝复用（请换 GY_I22_PG_ROOT）：${dataDir}`);
    runTool(TOOL('initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C']);
    // Debian/Ubuntu 的 `postgresql-17` 把编译默认 `unix_socket_directories` 钉在 `/var/run/postgresql`，
    // 普通用户（CI 里的 `runner`）写不了它 ⇒ `pg_ctl start` 会
    // `FATAL: could not create lock file "/var/run/postgresql/.s.PGSQL.<port>.lock": Permission denied`。
    // 本臂只走 TCP（`postgres://postgres@127.0.0.1:<port>`），socket 目录只影响那个 lock 文件 ⇒ 非 win32 上
    // 把它显式指到数据目录；Windows 没有 unix socket，传 `-k` 会报错，故只在非 win32 加。
    // 同仓 `tests/integration/*` 的自起集群脚本（`user-chain-e2e.mjs:313-315`、`media-row-purge-pg.mjs:105-110`
    // 等十余个）都是同一写法 —— 它们早就踩过这个坑，本臂是最后一个补上的。
    // ⚠ `-o` 只收**一个**字符串：数组必须 `join(' ')`，否则 postgres 会把 `,` 当成值的一部分
    // （`FATAL: invalid value for parameter "port": "55902,-c"`）。
    const startOptions = [`-p ${port}`, '-c listen_addresses=127.0.0.1'];
    if (process.platform !== 'win32') startOptions.push(`-k ${dataDir}`);
    runDetached(TOOL('pg_ctl'), ['-D', dataDir, '-l', logFile, '-w', '-t', '60', '-o', startOptions.join(' '), 'start']);
    clusterUp = true;
    await waitForReady(connectionString, 60000);

    owner = new pg.Client({ connectionString });
    await owner.connect();
    serverVersion = (await owner.query('SHOW server_version')).rows[0].server_version;
    if (!/^17\./.test(serverVersion)) throw new Error(`必须是 PostgreSQL 17.x，实测 ${serverVersion}`);
    console.log(`[pg] server_version=${serverVersion}`);

    const migrations = discoverMigrations();
    const first = await applyMigrations(owner, migrations);
    console.log(`[pg] migrations=${first.applied.length}（一次性空库，全部落地）`);

    pool = createPool(connectionString);
    // 缺陷 C-1：先把 `ai_enabled` 打开，再播种 / 跑用例——否则 createTurn 这族一律 409（见函数注释）。
    await armFeatureFlags(pool);
    // real 模式装配：loadConfig 走 stub（避免 REQUIRED_WHEN_REAL 的九项校验），再显式覆盖 executionMode。
    // 这与既有集成测试先例（user-chain-e2e.mjs）逐字同口径。
    //
    // 媒体域：real 下「有没有真实接线」由**装配层是否注入批准能力**决定
    // （`media/service.ts:603-616` 的 real 闸门 + `app.ts` 的 `realMediaApproval`），不是由「有没有桶」决定。
    // 这里用合成端点（见 SYNTHETIC_STORAGE_ENV）走生产同一个 resolver 显式接线，以让 C2 媒体族 6 条可跑。
    const storage = readObjectStorageConfig(SYNTHETIC_STORAGE_ENV);
    if (storage.config === null) {
      throw new Error(`合成对象存储配置非法：${storage.issues.map((issue) => `${issue.field}:${issue.code}`).join('; ')}`);
    }
    const config = {
      ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
      executionMode: 'real',
      requiresRealCredentials: true,
      mediaObjectRefKey: 'a'.repeat(64),
      objectStorage: storage.config,
      mediaAccessGrantOrigin: SYNTHETIC_MEDIA_GRANT_ORIGIN,
    };
    // 与生产入口同一条路径：`--approve-real-media-wiring` 显式运维动作 ⇒ 铸造批准能力 + s3_compatible 端口。
    // ⛔ 本臂是测试夹具，**没有**真凭据：端点固定 `.example.test`，AK/SK 是合成串，一次外呼都不许发生。
    const mediaPorts = resolveMediaRealPorts({
      config,
      argv: ['node', 'tests/failmatrix/run-real.mjs', MEDIA_REAL_WIRING_FLAG],
    });
    if (mediaPorts === null) throw new Error('媒体端口未解析（启动参数与 config 不一致）');
    // 应用时钟：**真 PG 臂走真实时钟**，不沿用 stub 臂那个冻结在 `START` 的脚本化时钟。
    // 理由是库侧的硬约束：`sessions` / `admin_sessions` / `idempotency_keys` 都有
    // `CHECK (expires_at > created_at)`，而 `created_at` 是列的 `DEFAULT now()`（真实墙钟），
    // 生产代码也用真实时钟算 `expires_at = now + TTL`；把应用时钟冻在 2026-10-25 而库是真实今天，
    // 任何带 `Idempotency-Key` 的写请求（连 `logout` 都带）都会把 `expires_at` 算到过去 ⇒ 必撞约束。
    // 2026-10-30 的 CI 第二轮就是这么红的（`sessions_expires_after_creation`，DETAIL 里
    // `expires_at=2026-10-27 04:00:00+00` 而 `created_at=2026-10-30 22:05:54+00`）。
    // 冻结时钟只属于 stub 臂（那里没有库、也没有 CHECK）；real 臂要的是「和库同一口时钟」。
    const clock = {
      now: () => new Date(),
    };
    app = buildApp({ config, pool, now: clock.now, ...mediaRealPortsAssemblyOptions(mediaPorts) });
    // 装配期就该是 0：`presignUpload` 只在本进程算签名，装配阶段连签名都不该跑。
    if (mediaPorts.objectStore.externalRequestCount !== 0) {
      throw new Error(`媒体端口在**装配期**就发了 ${mediaPorts.objectStore.externalRequestCount} 次外呼（隔离破防，⛔ 不得继续跑）`);
    }
    if (app.mediaService.failClosedReason !== null) {
      throw new Error(`媒体域接线后仍是 fail-closed：${app.mediaService.failClosedReason}`);
    }
    console.log(
      `[pg] media_ports=s3_compatible@${SYNTHETIC_STORAGE_ENV.OBJECT_STORAGE_ENDPOINT} external_requests=${mediaPorts.objectStore.externalRequestCount} fail_closed=null`,
    );

    // 播种时间基准取**库内 now()**（而不是 Node 的 Date.now()）：让夹具的 `expires_at` 与
    // `created_at` 的 `DEFAULT now()` 同源，钳制关系不因容器时钟/时区漂移再翻。
    const dbNowRow = await pool.query('SELECT (extract(epoch from now()) * 1000)::bigint AS ms');
    const dbNowMs = Number(dbNowRow.rows[0].ms);
    if (!Number.isFinite(dbNowMs)) throw new Error('未能从数据库取到 now()（会话播种的时间基准）');

    const world = { app, auth: app.authService.store, clock, config, dbNowMs };
    console.log(`[pg] db_now=${new Date(dbNowMs).toISOString()} app_clock=real`);

    // ------------------------------------------------------------ 夹具：账号
    const a = await createAccount(world, 'mx-a');
    const b = await createAccount(world, 'mx-b');
    const adminFull = await createAdmin(world, ALL_SCOPES, 'full');
    const adminNone = await createAdmin(world, [], 'none');
    const adminRead = await createAdmin(world, ['sources:read'], 'read');
    const deleter = await createAccount(world, 'mx-deleter');
    // ⚠ deleter 自己**不**真受理注销（2026-10-30 前这里写的是「real 模式整域 fail-closed」——那是过期口径，
    // 受理在 real + 真库下是开着的，见 domainUnavailable 上方注释）。不用的真因是**副作用**：受理会在同一
    // 事务里把 `users.state` 改成 `deletion_pending` 并撤销该账号**全部**会话
    //（`db/migrations/0016_account_deletion_persistence.sql:122-135`），而 C4-10/11/15/18 都靠 deleter 自己的
    // 用户会话过 `guards.requireUser`（`routes/account-deletion.ts:255`）⇒ 一受理就把它们打红。
    // 故这三个槽位**保持哨兵**：任何用例若回头从这里取注销单/回执，会在解析路径时抛 ⇒ 如实标 not-runnable，
    // ⛔ 而不是拿到别的账号的回执去凑绿（那是空断言）。
    deleter.deletionId = unavailableSeed('deleter 不真受理注销（受理会撤销它的全部会话）');
    deleter.receipt = unavailableSeed('deleter 不真受理注销（受理会撤销它的全部会话）');
    deleter.staleReceipt = unavailableSeed('deleter 不真受理注销（受理会撤销它的全部会话）');

    // -------------------------------------- 夹具：C4 回执族专用「已受理注销」账号
    // C4-12/13/14/16/17 要的是「一条真 `deletion_requests` 行 + 该单当前有效的回执摘要」。
    // 缺口是**能力**不是数据：回执摘要的投影走进程内/PG 台账（`privacy/account-deletion.ts:246-283`），
    // 且 GET 要求摘要反查命中且等于 path id（`routes/account-deletion.ts:329-331`）⇒ 只能在本进程里
    // 真 `inject(POST)` 受理一次，⛔ 不能退化成一份 `.sql` 种子。受理细节、换发语义与「为什么必须是
    // 另一个账号」写在 `world.mjs` 的 `seedReceiptHolder` 里（stub 臂用同一份夹具，两臂必须同构）。
    let receiptHolder;
    try {
      receiptHolder = await seedReceiptHolder(world, { createAccount, dispatch: (spec) => inject(app, spec) });
      console.log(`[pg] receipt_holder=${receiptHolder.userId} deletion=${receiptHolder.deletionId}（回执已换发一次）`);
    } catch (error) {
      // 播不上就把三个槽位一起换成会响的哨兵（**全或无**：绝不半套值混进读数）⇒ 这 5 条如实 not-runnable，
      // ⛔ 不让整臂抛死（否则连一份 180 条的诊断报告都拿不到）。
      const reason = error instanceof Error ? error.message : String(error);
      const dead = missingSeed(`注销受理（C4 回执族专用账号）—— ${reason}`);
      receiptHolder = { deletionId: dead, receipt: dead, staleReceipt: dead };
      console.warn(`[seed] 注销受理（C4 回执族）播种失败，C4-12/13/14/16/17 退回哨兵（继续 not-runnable）：${reason}`);
    }

    const seeded = await seedOwnerRowsReal(world, b, { pool, attacker: a });

    // ------------------------------------------- 夹具：C3-21 专用「待停用账号」
    // ⛔ 这个账号**只给** `cases.mjs:178` 的 C3-21（后台停用账号）用；任何其它用例都不许引用它
    // （自证口径：`git grep -n suspendTargetUserId -- tests` 只应有播种处 + 用例处两处）。
    //
    // 为什么必须隔离：C3-21 的 stub 期望是 503（账号写权威未注入），但 real 臂走的是**已接线**的
    // 真实停用路径，这条会**真的**把目标账号停用（侦察实测：`users.state=suspended`、
    // `auth_epoch 1→2`、`sessions.revoked_at` 比 `created_at` 晚 48 ms 被全部吊销）。它原先把
    // `ctx.b.userId` 当目标，而 B 是 C11 那组正控制（C11-35..39「B 仍能读自己的作业/识别/OCR/
    // 转写/会话」）**唯一**的受害账号 ⇒ B 一被停用，这五条在 real 下恒 401 `SESSION_EXPIRED`，
    // C11 的 same 就退化成「读不到」，不再证明「越权 404 打的是存在的行」。
    // 形状照 C3-25 的既有先例（同文件 471-501 另播一帖专供 `ctx.hideTargetPostId`）：
    // 一条破坏性写播一个专用目标，谁也不许动共享夹具。
    let suspendTargetUserId;
    try {
      const suspendTarget = await createAccount(world, 'mx-c3-21-suspend-target');
      suspendTargetUserId = suspendTarget.userId;
      // 它自带一条会话（`createAccount` 内 `createSession`）；该会话被 C3-21 吊销也无所谓——
      // 这个账号不参与任何正控制，吊销只影响它自己。
      console.log(`[pg] suspend_target=${suspendTargetUserId}（只给 C3-21 停用，C11 正控制不受影响）`);
    } catch (error) {
      // 播不上就留哨兵：C3-21 解析路径时会抛 ⇒ 如实记 not-runnable。
      // ⛔ 绝不退回 `ctx.b.userId`——那等于把「C11 正控制失真」这个缺陷原样引回来。
      suspendTargetUserId = unavailableSeed('账号（C3-21 专用停用目标）');
      warnSeed('停用目标账号（C3-21）', error);
    }

    const ctx = {
      world,
      API,
      // 供用例按执行模式选端点（`cases.mjs` 的 `auditReadPath`：审计读面在两种模式下是两条不同的真实实现）。
      mode: 'real',
      a,
      b,
      actors: { a, b, adminFull, adminNone, adminRead, deleter, receiptHolder },
      seeded,
      results: new Map(),
      lazy: new Map(),
      hideTargetPostId: seeded.hideTargetPostId,
      // C3-21 的专用停用目标（见 main() 里的播种块）。stub 臂没有这个槽位，用例行用 `??` 兜底。
      suspendTargetUserId,
      injection: '',
    };

    async function resolveActor(name, caseId) {
      if (name === undefined || name === null || name === 'guest') return null;
      const fixed = ctx.actors[name];
      if (fixed !== undefined) return fixed;
      const memoKey = `${name}:${caseId}`;
      if (ctx.lazy.has(memoKey)) return ctx.lazy.get(memoKey);
      let built;
      if (name === 'fresh') {
        built = await createAccount(world, `mx-fresh-${caseId}`);
      } else if (name === 'expired') {
        // 「已过期会话」不能靠 `expires_at` 直接给过去时间造：`created_at` 走列默认 `DEFAULT now()`，
        // `CHECK (expires_at > created_at)` 会把这条 INSERT 直接拒掉（2026-10-30 CI 首跑就是这么红的）。
        // 合规造法：先按正常未来时间插入，再把 `created_at` 与 `expires_at` **一起**回拨到过去——
        // 两者都进过去，`expires_at > created_at` 仍成立；对冻结在 `START` 的应用时钟也确实已过期。
        built = await createAccount(world, `mx-exp-${caseId}`);
        await pool.query(
          `UPDATE public.sessions
              SET created_at = now() - interval '10 days',
                  expires_at = now() - interval '9 days'
            WHERE id = $1::uuid`,
          [built.session],
        );
      } else if (name === 'stale') {
        built = await createAccount(world, `mx-stale-${caseId}`);
        await world.auth.bumpUserAuthEpoch(built.userId);
      } else if (name === 'logout') {
        built = await createAccount(world, `mx-logout-${caseId}`);
        const logout = await inject(world.app, {
          method: 'POST',
          path: `${API}/auth/logout`,
          actor: built,
          headers: { 'idempotency-key': `i22-realpg-c4-logout-${caseId}` },
        });
        if (logout.status !== 200) throw new Error(`logout 夹具失败 ${logout.status}：${logout.text}`);
      } else {
        throw new Error(`未知 actor：${name}（用例 ${caseId}）`);
      }
      ctx.lazy.set(memoKey, built);
      return built;
    }

    // ------------------------------------------------------------------ 跑用例
    const rows = [];
    for (const c of selected) {
      const entry = {
        id: c.id,
        family: c.family,
        title: c.title,
        actor: c.actor ?? 'guest',
        method: c.method,
        path: typeof c.path === 'function' ? '<fn>' : c.path,
        stubExpect: { status: c.expect?.status ?? null, code: c.expect?.code ?? null },
        actual: null,
        verdict: 'not-runnable',
        reason: null,
        problems: [],
        checkProblems: [],
        shapeProblems: [],
        // 该条**携带**什么断言、有没有真跑：`none` = 不带；`not-reached` = 带了但本条没跑到；
        // `ran` / `compared` = 真跑过（reading 才算数）。
        assertions: {
          check: typeof c.check === 'function' ? 'not-reached' : 'none',
          shape: c.sameShapeAs !== undefined ? 'not-reached' : 'none',
        },
        shape: null,
      };

      let actor;
      let request;
      try {
        actor = await resolveActor(c.actor, c.id);
        request = {
          method: c.method,
          path: resolveValue(c.path, ctx),
          actor,
          body: resolveValue(c.body, ctx),
          headers: resolveValue(c.headers, ctx) ?? {},
        };
      } catch (error) {
        entry.reason = fixtureReason(error);
        rows.push(entry);
        continue;
      }

      if (c.concurrent !== undefined) {
        entry.reason = '并发用例在真 PG 臂不跑（stub 内存并发语义与真库不同源），保持未取得';
        rows.push(entry);
        continue;
      }

      if (c.app === 'jobs' && !(JOB_FILTER_LEGS.has(c.id) && seeded.jobFilterSeedOk === true)) {
        // ⛔ 按**具体用例**分腿，不再按 `c.app === 'jobs'` 一刀切：C3-28…C3-36 已接真实执行（读面见顶部
        // `JOB_FILTER_LEGS` 的注释，种子见 `seedFailClosedRowsReal` 的 S8）；其余 `app: 'jobs'` 腿仍记「未取得」。
        // 种子没落库时同样退回「未取得」——没有行可读的 200 是假读数，不算 same。
        entry.reason = seeded.jobFilterSeedOk === true
          ? '作业过滤腿未接线（本臂只接了 C3-28…C3-36 这 9 条，其余 jobs 腿保持未取得）'
          : '作业过滤腿种子未落库（真库 `public.ocr_jobs` 播种失败，见上方 [seed] 告警）⇒ 无行可读，保持未取得';
        rows.push(entry);
        continue;
      }

      let result;
      try {
        result = await inject(world.app, request);
      } catch (error) {
        entry.reason = `inject 抛错：${error?.message ?? error}`;
        rows.push(entry);
        continue;
      }

      entry.path = request.path;
      entry.actual = { status: result.status, code: codeOf(result), mode: result.body?.meta?.execution_mode ?? null };
      const verdict = verdictFor(c, result, ctx);
      entry.problems = verdict.problems;
      entry.checkProblems = verdict.checkProblems;
      if (verdict.checkRan) entry.assertions.check = 'ran';
      ctx.results.set(c.id, result);
      // 与 `run.mjs:383` 同构：`after` 无论本条 same/different 都执行。C3-31 靠它把**真游标**写进 ctx，
      // 否则 C3-32/C3-33 会拿 `ctx.jobFilterCursor = null` ⇒ `cursor=no-cursor` 假跑（那是自欺，不是证据）。
      if (typeof c.after === 'function') c.after(result, ctx);
      if (verdict.same) {
        entry.verdict = 'same';
      } else {
        // 缺陷 B：同一根因「整域不可用」不许一半算 `not-runnable`、一半算 `different`（14 条里 8 条是噪音）。
        const unavailable = domainUnavailable(result);
        if (unavailable !== null) {
          entry.verdict = 'not-runnable';
          entry.reason = unavailable;
          entry.reclassifiedFrom = 'different';
        } else {
          entry.verdict = 'different';
        }
      }
      rows.push(entry);
    }

    // ------------------------------------------------ 后置：`sameShapeAs` 同形比对
    const shapeTally = shapePostPass(rows, ctx);

    // ------------------------------------------------------------------ 打报告
    const commit = baseCommit();
    const tally = {
      same: 0,
      different: 0,
      notRunnable: 0,
      // `same` 的三段拆分（互斥）：真跑过 check / 真比对过同形 / 两者都带（cases.mjs 里没有同时带的）/ 都不带
      sameWithCheck: 0,
      sameWithShape: 0,
      sameWithEither: 0,
      sameWithNeither: 0,
      // 携带 `sameShapeAs` 但对照组本次没读数 ⇒ 没比过（⛔ 不算通过，单列出来）
      sameWithShapeUnchecked: 0,
      differentFromCheck: 0,
      differentFromShape: 0,
      reclassifiedToNotRunnable: 0,
      notRunnableByKind: {},
    };
    const familyTally = new Map();
    for (const row of rows) {
      if (row.verdict === 'same') {
        tally.same += 1;
        const ranCheck = row.assertions.check === 'ran';
        const comparedShape = row.assertions.shape === 'compared';
        if (ranCheck) tally.sameWithCheck += 1;
        if (comparedShape) tally.sameWithShape += 1;
        if (ranCheck || comparedShape) tally.sameWithEither += 1;
        else {
          tally.sameWithNeither += 1;
          if (row.assertions.shape === 'unavailable') tally.sameWithShapeUnchecked += 1;
        }
      } else if (row.verdict === 'different') {
        tally.different += 1;
        if (row.checkProblems.length > 0) tally.differentFromCheck += 1;
        if (row.shapeProblems.length > 0) tally.differentFromShape += 1;
      } else {
        tally.notRunnable += 1;
        if (row.reclassifiedFrom === 'different') tally.reclassifiedToNotRunnable += 1;
        const kind = notRunnableKind(row.reason);
        tally.notRunnableByKind[kind] = (tally.notRunnableByKind[kind] ?? 0) + 1;
      }
      const t = familyTally.get(row.family) ?? { total: 0, same: 0, different: 0, notRunnable: 0 };
      t.total += 1;
      if (row.verdict === 'same') t.same += 1;
      else if (row.verdict === 'different') t.different += 1;
      else t.notRunnable += 1;
      familyTally.set(row.family, t);
    }

    console.log(`\nGY-I22 失败矩阵 · 真实 PostgreSQL 17 臂 · 基线 ${commit.slice(0, 12)}`);
    console.log(`时间 ${new Date().toISOString()} · node ${process.version} · PostgreSQL ${serverVersion}`);
    console.log(`权限面 ${selected.length} 条（C1–C4/C10/C11）· 逐条记录 stub 期望 vs 真 PG 实际\n`);

    let lastFamily = null;
    for (const row of rows) {
      if (row.family !== lastFamily) {
        lastFamily = row.family;
        console.log(`\n[${row.family}] ${FAMILIES[row.family] ?? ''}`);
      }
      const actual = row.actual
        ? `${row.actual.status} ${row.actual.code ?? '-'}`
        : '（未跑）';
      const tag = row.verdict === 'same' ? 'SAME' : row.verdict === 'different' ? 'DIFF' : 'NRUN';
      console.log(`  ${tag} ${row.id.padEnd(6)} ${row.method.padEnd(6)} ${row.path} → 真PG ${actual} · stub期望 ${row.stubExpect.status ?? '-'} ${row.stubExpect.code ?? '-'} · ${row.title}`);
      if (row.verdict === 'different') {
        for (const problem of row.problems) console.log(`       ✗ ${problem}`);
        for (const problem of row.checkProblems) console.log(`       ✗ [check] ${problem}`);
        for (const problem of row.shapeProblems) console.log(`       ✗ [shape] ${problem}`);
      }
      if (row.verdict === 'not-runnable' && row.reason) {
        console.log(`       · ${row.reason}`);
      }
      if (row.verdict === 'same' && row.shape?.state === 'unavailable') {
        console.log(`       · ⚠ ${row.shape.reason}（该条 same 只是状态码级）`);
      }
    }

    // ---------------------------------------------------- 隔离终检：整臂零外呼（媒体域接线后新增的判据）
    // 六个 C2 媒体腿都在「碰字节之前」返回；一旦有人把判据改宽到真取字节，这里立刻炸。
    if (mediaPorts.objectStore.externalRequestCount !== 0) {
      throw new Error(`媒体端口在整臂运行期发了 ${mediaPorts.objectStore.externalRequestCount} 次外呼（隔离破防）`);
    }
    if (fetchCalls.length !== 0) {
      throw new Error(`整臂发生了 ${fetchCalls.length} 次 fetch（隔离破防）：${fetchCalls.join(' | ')}`);
    }
    console.log(`[pg] media_external_requests=${mediaPorts.objectStore.externalRequestCount} fetch_calls=${fetchCalls.length}（整臂零外呼）`);

    console.log('\n———————————————— 汇总 ————————————————');
    for (const [family, t] of familyTally) {
      console.log(`${family} ${String(FAMILIES[family] ?? '').slice(0, 26)}… ${t.total} 条：same ${t.same} / different ${t.different} / not-runnable ${t.notRunnable}`);
    }
    // 六桶读数：`same` 已经要求「携带的断言真跑过且全过」，故 sameWithCheck / sameWithShape 是它的**子集**。
    console.log(`\n权限面合计 ${rows.length} 条：same ${tally.same} / sameWithCheck ${tally.sameWithCheck} / sameWithShape ${tally.sameWithShape} / different ${tally.different} / not_runnable ${tally.notRunnable}`);
    console.log(`  判据强度：same 里真跑过断言 ${tally.sameWithEither} 条（check ${tally.sameWithCheck} + 同形 ${tally.sameWithShape}），只比 status/code ${tally.sameWithNeither} 条`);
    if (tally.sameWithShapeUnchecked > 0) {
      console.log(`  ⚠ 带了同形判据但对照组没读数 ⇒ 没比过 ${tally.sameWithShapeUnchecked} 条（不算通过）`);
    }
    console.log(`  差异归因：different ${tally.different} 条（status/code/check 判红 ${tally.differentFromCheck} · 同形比对判红 ${tally.differentFromShape}）`);
    console.log(`  not-runnable ${tally.notRunnable} 条：${Object.entries(tally.notRunnableByKind).map(([kind, n]) => `${kind} ${n}`).join(' / ') || '（无）'}；其中由 different 改判 ${tally.reclassifiedToNotRunnable} 条`);
    console.log(`  同形比对：真比过 ${shapeTally.compared} 条（不一致 ${shapeTally.mismatched}）· 对照组缺读数 ${shapeTally.unavailable} 条`);

    // 差异结论（只列 different 与 not-runnable 的标题，供直接贴证据页）。
    console.log('\n———— stub vs 真 PG 差异结论 ————');
    const diffs = rows.filter((row) => row.verdict === 'different');
    const nrun = rows.filter((row) => row.verdict === 'not-runnable');
    if (diffs.length === 0) console.log('（无：权限面在 stub 与真 PG 下逐条一致）');
    for (const row of diffs) {
      const why = [...row.problems, ...row.checkProblems, ...row.shapeProblems].join('；');
      console.log(`  DIFF ${row.id}：stub ${row.stubExpect.status} ${row.stubExpect.code ?? '-'} → 真PG ${row.actual.status} ${row.actual.code ?? '-'}（${why}）`);
    }
    for (const row of nrun) {
      console.log(`  NRUN ${row.id}：${row.reason}`);
    }

    if (opts.json !== null) {
      const { mkdirSync: mkdir, writeFileSync } = await import('node:fs');
      mkdir(path.dirname(path.resolve(opts.json)), { recursive: true });
      writeFileSync(opts.json, `${JSON.stringify({
        generated_at: new Date().toISOString(),
        node: process.version,
        base_commit: commit,
        postgres: serverVersion,
        execution_mode: 'real',
        transport: 'app.inject (real PG stores)',
        totals: {
          total: rows.length,
          same: tally.same,
          sameWithCheck: tally.sameWithCheck,
          sameWithShape: tally.sameWithShape,
          sameWithEither: tally.sameWithEither,
          sameWithNeither: tally.sameWithNeither,
          sameWithShapeUnchecked: tally.sameWithShapeUnchecked,
          different: tally.different,
          differentFromCheck: tally.differentFromCheck,
          differentFromShape: tally.differentFromShape,
          not_runnable: tally.notRunnable,
          notRunnableByKind: tally.notRunnableByKind,
          reclassifiedToNotRunnable: tally.reclassifiedToNotRunnable,
        },
        shapePass: shapeTally,
        families: Object.fromEntries([...familyTally].map(([family, t]) => [family, t])),
        rows,
      }, null, 2)}\n`, 'utf8');
      console.log(`机读结果：${opts.json}`);
    }

    const elapsed = Date.now() - startedAt;
    console.log(`\n真 PG 臂完成：${rows.length} 条权限面用例在 PostgreSQL ${serverVersion} 上取得逐条读数，耗时 ${elapsed} ms（same=${tally.same} sameWithCheck=${tally.sameWithCheck} sameWithShape=${tally.sameWithShape} different=${tally.different} not-runnable=${tally.notRunnable}）。`);
    return 0;
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    console.error(`\n真 PG 臂 FAIL：${error?.stack ?? error}（耗时 ${elapsed} ms）`);
    if (existsSync(logFile)) {
      const { readFileSync } = await import('node:fs');
      const log = readFileSync(logFile, 'utf8');
      if (log.trim() !== '') console.error(`--- postgres log 末 20 行 ---\n${log.split('\n').slice(-20).join('\n')}`);
    }
    return 1;
  } finally {
    if (app !== null) await app.close().catch(() => {});
    if (pool !== null) await pool.end().catch(() => {});
    if (owner !== null) await owner.end().catch(() => {});
    if (!keep) {
      try {
        if (clusterUp) await stopAndRemoveCluster(dataDir);
        if (existsSync(logFile)) unlinkSync(logFile);
        console.log('[pg] 一次性集群已停止，数据目录已删除');
      } catch (error) {
        console.log(`[pg] 数据目录清理失败（需人工确认，不影响读数）：${error?.message ?? error}`);
      }
    } else {
      if (clusterUp) {
        try {
          runDetached(TOOL('pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', '-t', '60', 'stop']);
        } catch (error) {
          console.log(`[pg] 停止失败（需人工确认）：${error?.message ?? error}`);
        }
      }
      console.log(`[pg] GY_I22_PG_KEEP=1：保留 ${dataDir}`);
    }
  }
}

process.exitCode = await main();
