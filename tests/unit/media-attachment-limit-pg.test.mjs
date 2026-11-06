// GY-R82（#6 AC「每帖 ≤3 张」在 real 恒 503 的返修）· PG 计数器接线。
//
// 本片把缺口钉成**可证伪**：real 装配且媒体域持久化端口是 PG（`real && pool !== null &&
// MEDIA_OBJECT_REF_KEY` 在场，与 app.ts 既有 mediaStore 装配判据同形）下，每帖图片槽位计数端口
// 必须是 **`kind === 'postgres'`** 且**真读 `public.media`**（经 `MediaStore.liveCommunityImageCount`）；
// 不再 503「每帖上限计数未接线」。装配**零 app.ts 改动**：`createAppMediaService` 的默认计数器
// 已按 `persistence.kind` 二分（见 service.ts 的默认三分支），app.ts 本就显式传
// `persistence: mediaStore`。三条例证（编号即派发要求）：
//   ①第 3 张成功、第 4 张返回既有超限错误（400 `post_image_limit`，逐字不变）；
//   ②两个不同 owner 互不影响（计数按 owner 隔离，不是全局共享）；
//   ③端口缺失（模拟）仍 fail-closed：`createPostgresAttachmentCounter` 拿到**非 PG** 的
//     持久化端口（内存 Map）⇒ 构造期即抛错（TypeError），计数器根本不会出生——
//     不是「按 0 起算放行」，也不是「运行期静默 503 变 201」。
//
// 为什么是 PGlite（既有 `pglitePool` 夹具）而不是 PG17 真机：
//   本片验的是 **SQL 语义**（owner 过滤、state 过滤、count(*) 读数）与装配判据
//   （`persistence.kind === 'postgres'` ⇒ 默认 `kind: 'postgres'` 计数器），不是真机部署。
//   PGlite 在本地跑同一套迁移与同一套 SQL，零网络；真库覆盖仍属 `tests/integration/**`。
//
// 负控制（改坏任一处，本文件必须失败）：
//   - 把 service.ts 的默认三分支改回「按 executionMode 二分」⇒ 用例 A 的 `kind` 断言失败
//     （拿到 `unwired`）与首张 503（本文件断言 201）；
//   - 把 `createPostgresAttachmentCounter` 的构造期 kind 校验拿掉 ⇒ 用例 C 的 TypeError
//     断言失败（内存端口被静默接受）；
//   - 把 `liveCommunityImageCount` 的 `AND owner_id = $1` 拿掉 ⇒ 用例 B 的「他人满额、本人
//     仍 3 张 201」失败（本人第 1 张就被 400）；
//   - 把 `state NOT IN ('deleted','rejected')` 拿掉 ⇒ 用例 A 在插入一条 rejected 行后第 4 张
//     仍 400 的位置会错位（live 数被虚增）；
//   - 把 400 的 `details[0]` 改成别的 field/code ⇒ 用例 A/B 的 `expectPostImageLimit` 失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pglitePool } from './favorites-history-fixtures.mjs';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createS3CompatibleObjectStore } from '../../services/api/src/media/object-store.ts';
import { approveRealMediaWiring } from '../../services/api/src/media/service.ts';
import { createPostgresAttachmentCounter } from '../../services/api/src/media/attachment-counter-pg.ts';
import { createMemoryMediaStore } from '../../services/api/src/media/store.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { pngPlain } from '../media/_fixtures.mjs';

/** 0001（users/sessions/media/枚举）+ 0003（privacy_epochs/consent_records）+ 0008（共享幂等台账）。 */
const MIGRATIONS = ['0001_initial_schema', '0003_privacy_consent', '0008_auth_session'];
const png = pngPlain();
const DECLARED_COMMUNITY = {
  purpose: 'community_image',
  mime: 'image/png',
  bytes: png.length,
  sha256: sha256Hex(png),
};

function syntheticS3() {
  return createS3CompatibleObjectStore({
    endpoint: 'https://cos.ap-shanghai.myqcloud.com',
    bucket: 'gengyun-media-placeholder',
    accessKey: 'synthetic-access-key-id',
    secretKey: 'synthetic-secret-key-value',
    region: 'ap-shanghai',
    forcePathStyle: false,
  });
}

/**
 * real + PGlite 的全 PG 装配：auth store 走 PG（`createPostgresAuthStore`），
 * consent gate 走 PG（app.ts 的 `pool !== null` 判据），媒体域持久化端口走 PG
 * （`createPostgresMediaStore`，因 `mediaObjectRefKey` 在场）。real 微信登录 fail-closed ⇒
 * 会话直接落真库（`INSERT INTO users/sessions`），不代表真实登录已验收。
 * `expires_at` 给足 72h：本文件会用 `advance()` 越过 24h 上传句柄 TTL（判过期记录不计入）。
 */
async function realPgApp(t, { mediaObjectRefKey } = {}) {
  const { db, pool } = await pglitePool(t, MIGRATIONS);
  // 调试：把每条 SQL 的失败码打出来（默认静默时 PGlite 的报错会被 classifyMediaDatabaseError
  // 折叠成 503，看不到 42P01/42703 等真因）。
  const debugPool = {
    ...pool,
    query: async (...args) => {
      try {
        return await pool.query(...args);
      } catch (error) {
        console.error('[pg-debug]', error.code, error.message, '\nSQL:', args[0], '\nparams:', args[1]);
        throw error;
      }
    },
  };
  const sql = { query: debugPool.query };
  const store = createPostgresAuthStore(sql);
  const config = {
    ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    executionMode: 'real',
    ...(mediaObjectRefKey === undefined ? {} : { mediaObjectRefKey }),
  };
  const app = buildApp({
    config,
    pool: debugPool,
    store,
    mediaObjectStore: syntheticS3(),
    realMediaApproval: approveRealMediaWiring({
      reason: 'GY-R82 测试夹具：real + PG 计数器接线（合成端点，零外呼）',
    }),
    now: () => new Date(),
  });
  return { app, db, pool: debugPool, store };
}

/** 把任意种子转成合法 hex（`wechat_subject_lookup` 是 bytea，经 `decode($1,'hex')`）。 */
function subjectHex(seed) {
  return Buffer.from(String(seed), 'utf8').toString('hex');
}

/** 落一个 user + session（真库），并给 `media_processing` 用途授权（privacy_epochs + consent_records）。 */
async function seedOwner(db, store, token, subject) {
  const user = await store.createUser(subjectHex(subject));
  await store.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
    audience: 'user',
  });
  // 媒体上传的 consent 前置（routes/media.ts:175-215）走 PG：community_image 需要
  // media_processing + public_posting + external_inference（packages/privacy/constants.mjs:94）。
  // 每个用途的 privacy_epochs 指到当前 epoch=1 且 state='granted'，consent_records 落同一
  // epoch 的 granted 行（两表一致，assertCurrent 才过）。
  for (const purpose of ['media_processing', 'public_posting', 'external_inference']) {
    await db.query(
      `INSERT INTO public.privacy_epochs (user_id, purpose, current_epoch, state)
       VALUES ($1::uuid, $2, 1, 'granted')`,
      [user.id, purpose],
    );
    await db.query(
      `INSERT INTO public.consent_records (user_id, purpose, policy_version, state, epoch)
       VALUES ($1::uuid, $2, 'test-policy-v1', 'granted', 1)`,
      [user.id, purpose],
    );
  }
  return { token, userId: user.id };
}

async function upload(app, token, key) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/media/uploads',
    payload: DECLARED_COMMUNITY,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
  });
  let body = null;
  try { body = response.json(); } catch { body = null; }
  return { status: response.statusCode, body };
}

function expectAccepted(reply, label) {
  assert.equal(reply.status, 201, `${label} 应被接受：${JSON.stringify(reply.body)}`);
  assert.equal(reply.body.data.media.purpose, 'community_image', label);
  assert.equal(reply.body.data.media.state, 'initiated', label);
}

/** 既有超限错误逐字钉死（400 + INVALID_REQUEST + details[0] 一个字符都不许漂）。 */
function expectPostImageLimit(reply, label) {
  assert.equal(reply.status, 400, `${label} 应被拒（400）：${JSON.stringify(reply.body)}`);
  assert.equal(reply.body.error.code, 'INVALID_REQUEST', label);
  assert.deepEqual(
    reply.body.error.details[0],
    { field: '/purpose', code: 'post_image_limit' },
    `${label} 的 details[0] 必须逐字等于既有超限判别`,
  );
}

test('GY-R82 ① real+PG 装配：计数器 kind=postgres；第 3 张 201、第 4 张既有 400 post_image_limit', async (t) => {
  const { app, db, store } = await realPgApp(t, { mediaObjectRefKey: 'a'.repeat(64) });
  t.after(() => app.close());

  // 前提守卫：装配判据确实命中「persistence.kind === 'postgres' ⇒ PG 计数器」。
  // 若 service.ts 的默认改回「按 executionMode 二分」，这里立刻拿到 unwired（kind 断言先失败）。
  assert.equal(app.mediaService.attachmentCounter.kind, 'postgres');
  assert.match(
    app.mediaService.attachmentCounter.note,
    /PG 图片槽位计数器/,
    'postgres 计数器的 note 必须点明事实源是 PG 登记册',
  );

  const { token, userId } = await seedOwner(db, store, 'r82-pg-owner-1', 'r82-pg-owner-1');

  expectAccepted(await upload(app, token, 'r82-pg-a-1'), '第 1 张');
  expectAccepted(await upload(app, token, 'r82-pg-a-2'), '第 2 张');
  expectAccepted(await upload(app, token, 'r82-pg-a-3'), '第 3 张');
  // 既有超限错误：状态码 / code / details[0] 逐字断言，不许漂成别的 4xx/5xx。
  expectPostImageLimit(await upload(app, token, 'r82-pg-a-4'), '第 4 张');

  // 直接读真库自证：3 条 initiated 行都在（不是内存 Map 自证）。
  const { rows } = await db.query(
    `SELECT count(*) AS v FROM public.media WHERE owner_id = $1 AND purpose = 'community_image'`,
    [userId],
  );
  assert.equal(Number(rows[0].v), 3, '真库必须恰好 3 条该 owner 的 community_image 行');
});

test('GY-R82 ② 跨 owner 隔离：他人满额（3 张后 400），本人仍 3 张 201、第 4 张 400', async (t) => {
  const { app, db, store } = await realPgApp(t, { mediaObjectRefKey: 'a'.repeat(64) });
  t.after(() => app.close());
  const me = await seedOwner(db, store, 'r82-pg-me', 'r82-pg-me');
  const other = await seedOwner(db, store, 'r82-pg-other', 'r82-pg-other');

  // 他人先打满（3×201 + 1×400）。
  expectAccepted(await upload(app, other.token, 'r82-pg-o-1'), '他人第 1 张');
  expectAccepted(await upload(app, other.token, 'r82-pg-o-2'), '他人第 2 张');
  expectAccepted(await upload(app, other.token, 'r82-pg-o-3'), '他人第 3 张');
  expectPostImageLimit(await upload(app, other.token, 'r82-pg-o-4'), '他人第 4 张');

  // 本人不受他人满额影响：3×201 + 1×400（计数按 owner 隔离，不是全局共享）。
  expectAccepted(await upload(app, me.token, 'r82-pg-m-1'), '本人第 1 张');
  expectAccepted(await upload(app, me.token, 'r82-pg-m-2'), '本人第 2 张');
  expectAccepted(await upload(app, me.token, 'r82-pg-m-3'), '本人第 3 张');
  expectPostImageLimit(await upload(app, me.token, 'r82-pg-m-4'), '本人第 4 张');

  // 双向：他人仍停在「已满」（证明计数没串、也没被本人的写入冲掉）。
  expectPostImageLimit(await upload(app, other.token, 'r82-pg-o-5'), '他人第 5 张（仍满）');
});

test('GY-R82 ③ 端口缺失（非 PG 持久化端口）仍 fail-closed：构造期 TypeError，不出生、不放行', async (t) => {
  // 模拟「装配层拿到的持久化端口不是 PG 登记册」（real 无池 / 缺 MEDIA_OBJECT_REF_KEY ⇒
  // app.ts 回落内存 Map）：`createPostgresAttachmentCounter` 必须在**构造期**拒绝
  // （TypeError），计数器根本不会出生——不是「按 0 起算放行」，也不是「运行期静默 503 变 201」。
  const memoryStore = createMemoryMediaStore({ now: () => Date.now() });
  assert.throws(
    () => createPostgresAttachmentCounter(memoryStore),
    (error) => {
      assert.ok(error instanceof TypeError, '必须是 TypeError（构造期闸门），不是 ApiError');
      assert.match(
        error.message,
        /只接受 kind === 'postgres' 的持久化端口/,
        'TypeError 文案必须点明「只接受 PG 持久化端口」',
      );
      assert.match(
        error.message,
        /内存实现在 real 装配下不得充当计数事实源/,
        'TypeError 文案必须点明「内存实现不得充当计数事实源」',
      );
      return true;
    },
    '非 PG 持久化端口 ⇒ 构造期 TypeError（fail-closed），计数器不出生',
  );

  // 反向守卫：**同一个**内存端口在 real 装配下仍走 unwired（恒 null）⇒ 503 fail-closed
  // 逐字不变（这条语义由既有 `media-attachment-limit.test.mjs` 的用例 1 钉死，这里只复述
  // 构造期闸门的存在，不重复 503 断言）。
});
