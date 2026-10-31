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
import { API, SPECIES_ID, inject } from './world.mjs';

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
const { RULE_VERSION } = await import('../../packages/moderation/rule-version.mjs');
const { missingContractFields } = await import('../../packages/moderation/review.mjs');

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
 * 真 PG 世界的属主行播种（B 的私有行）。
 * 能播的播（收藏 / 历史 / 消息 / 会话，走 HTTP 或服务原语）；real 模式下 HTTP 写面 fail-closed 的那几组
 * （社区投稿 / 举报 / 作业 / 识别 / OCR / 转写）改为按**真表**在库里播种（见 `seedFailClosedRowsReal`）。
 * 任何一组播不上就**保留原 `unavailableSeed` 哨兵**并 `console.warn` 一行原因 ⇒ 对应用例继续 `not-runnable`，
 * ⛔ 不拿「不存在」当「越权 404」的假同形，也⛔ 不让整臂抛死。
 */
async function seedOwnerRowsReal(world, owner, { pool, attacker }) {
  const seeded = {
    media: unavailableSeed('媒体（对象存储未接线）'),
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
    conversationId: null,
    conversationEtag: null,
    turnId: null,
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
  try {
    const conversation = await inject(world.app, {
      method: 'POST',
      path: `${API}/conversations`,
      actor: owner,
      body: {},
      headers: { 'idempotency-key': 'i22-realpg-seed-conv' },
    });
    if (conversation.status === 201) {
      const conversationId = conversation.body?.data?.id ?? null;
      seeded.conversationId = conversationId;
      if (conversationId !== null) {
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
        seeded.turnId = turn.body?.data?.id ?? null;
      }
    }
  } catch {
    /* 会话域不可播 */
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
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------
function codeOf(result) {
  return result.body?.error?.code ?? null;
}

/** 逐条判定：只比 `status` + `code`（stub 期望 vs 真 PG 实际），并记录真模式的执行模式不变量。 */
function verdictFor(c, result) {
  const exp = c.expect ?? {};
  const actualCode = codeOf(result);
  const problems = [];
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
  const same = problems.length === 0;
  return { same, problems, metaMode };
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
    // real 模式装配：loadConfig 走 stub（避免 REQUIRED_WHEN_REAL 的九项校验），再显式覆盖 executionMode。
    // 这与既有集成测试先例（user-chain-e2e.mjs）逐字同口径。
    const config = {
      ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
      executionMode: 'real',
      requiresRealCredentials: true,
      mediaObjectRefKey: 'a'.repeat(64),
    };
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
    app = buildApp({ config, pool, now: clock.now });

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
    // 注销受理在 real 模式整域 fail-closed（503），注销单/回执 bearer 无法播种 ⇒ 置哨兵，
    // 依赖它们的 C4 注销回执用例在跑之前解析即抛 ⇒ 如实标 not-runnable。
    deleter.deletionId = unavailableSeed('注销受理（real 模式整域 fail-closed）');
    deleter.receipt = unavailableSeed('注销受理（real 模式整域 fail-closed）');
    deleter.staleReceipt = unavailableSeed('注销受理（real 模式整域 fail-closed）');

    const seeded = await seedOwnerRowsReal(world, b, { pool, attacker: a });

    const ctx = {
      world,
      API,
      a,
      b,
      actors: { a, b, adminFull, adminNone, adminRead, deleter },
      seeded,
      results: new Map(),
      lazy: new Map(),
      hideTargetPostId: seeded.hideTargetPostId,
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
        entry.reason = `夹具不可用（real 模式该域 fail-closed）：${error?.message ?? error}`;
        rows.push(entry);
        continue;
      }

      if (c.concurrent !== undefined) {
        entry.reason = '并发用例在真 PG 臂不跑（stub 内存并发语义与真库不同源），保持未取得';
        rows.push(entry);
        continue;
      }

      if (c.app === 'jobs') {
        // S-6 的作业过滤腿依赖 `createJobFilterWorld` 的**已接线内存作业端口 + 固定种子**（真 PG 侧没有
        // 作业读权威可播种）。本臂如实记「未取得」，不算 same、也不伪装 PASS；stub 臂与单测里这 9 条全跑。
        entry.reason = '作业过滤腿需要已接线的内存作业端口（stub 参考实现 + 固定种子）；real + 真库无作业读权威，本臂不跑';
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
      const verdict = verdictFor(c, result);
      entry.problems = verdict.problems;
      entry.verdict = verdict.same ? 'same' : 'different';
      ctx.results.set(c.id, result);
      rows.push(entry);
    }

    // ------------------------------------------------------------------ 打报告
    const commit = baseCommit();
    const tally = { same: 0, different: 0, notRunnable: 0 };
    const familyTally = new Map();
    for (const row of rows) {
      if (row.verdict === 'same') tally.same += 1;
      else if (row.verdict === 'different') tally.different += 1;
      else tally.notRunnable += 1;
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
      }
      if (row.verdict === 'not-runnable' && row.reason) {
        console.log(`       · ${row.reason}`);
      }
    }

    console.log('\n———————————————— 汇总 ————————————————');
    for (const [family, t] of familyTally) {
      console.log(`${family} ${String(FAMILIES[family] ?? '').slice(0, 26)}… ${t.total} 条：same ${t.same} / different ${t.different} / not-runnable ${t.notRunnable}`);
    }
    console.log(`\n权限面合计 ${rows.length} 条：same ${tally.same} / different ${tally.different} / not-runnable ${tally.notRunnable}`);

    // 差异结论（只列 different 与 not-runnable 的标题，供直接贴证据页）。
    console.log('\n———— stub vs 真 PG 差异结论 ————');
    const diffs = rows.filter((row) => row.verdict === 'different');
    const nrun = rows.filter((row) => row.verdict === 'not-runnable');
    if (diffs.length === 0) console.log('（无：权限面在 stub 与真 PG 下逐条一致）');
    for (const row of diffs) {
      console.log(`  DIFF ${row.id}：stub ${row.stubExpect.status} ${row.stubExpect.code ?? '-'} → 真PG ${row.actual.status} ${row.actual.code ?? '-'}（${row.problems.join('；')}）`);
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
        totals: { total: rows.length, same: tally.same, different: tally.different, not_runnable: tally.notRunnable },
        families: Object.fromEntries([...familyTally].map(([family, t]) => [family, t])),
        rows,
      }, null, 2)}\n`, 'utf8');
      console.log(`机读结果：${opts.json}`);
    }

    const elapsed = Date.now() - startedAt;
    console.log(`\n真 PG 臂完成：${rows.length} 条权限面用例在 PostgreSQL ${serverVersion} 上取得逐条读数，耗时 ${elapsed} ms（same=${tally.same} different=${tally.different} not-runnable=${tally.notRunnable}）。`);
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
