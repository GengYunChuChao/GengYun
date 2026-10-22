// GY-R28 W12 媒体持久化 · **合流补测（PR #419）**：并发读数与幂等 scope 判定，全部打真 PostgreSQL 17。
//
// 与 `tests/integration/media-persistence-pg.mjs` 的分工：那份证「事实真的落库」（三段式入库、
// 重启可读、装配 fail-closed），这份只补**并发面**的三个读数：
//   [A] 同一媒体对象两次**并发** `complete`（不同 Idempotency-Key、同一 If-Match "1"）
//       ⇒ 恰好一次 202、一次 409 `REVISION_CONFLICT`（契约里 409 的等价对）。
//       窗口用**桶闸**构造：两条 complete 都已读到 rev1/initiated 快照、都卡在 `getObject`，
//       再同时放行 —— 于是两边都过 `requireIfMatch`，最终拼的是末尾那条条件写
//       `saveMediaIfCurrent`（`WHERE id AND revision=$ AND state=$`），只能有一行落库。
//   [B] 同一个 `Idempotency-Key` 跨主体使用 ⇒ 按 **scope（主体+方法+路由模板）** 判定，互不串台：
//       B1 两个主体各自 201、两条 media 行、两把独立 scope；
//       B2 同一 key 同一媒体、换主体 complete ⇒ 404（归属判定在幂等之后的 `ownedRecord`），
//          且**不**回放他人的回执、不在对方 scope 留台账行；
//       B3 同主体同 key 异请求体 ⇒ 409 `IDEMPOTENCY_CONFLICT`（对照组：证明 scope 相等才会撞）。
//   [C] `reject()` 的**布尔返回语义**：落库 1 行才返回 true；条件写 0 行返回 false，
//       且不得把先到者的终态（`deleted`）覆盖回去。
//       C1 true 分支：`expireInitiated` 的计数等于库内 initiated 行数，行变 rejected/expired。
//       C2 false 分支：同一条 initiated 行在窗口里被 `delete` 推进到 deleted/rev2，放行后
//          `reject` 的条件写 0 行 ⇒ 计数 0、库里仍是 deleted、`failure_code` 仍为 NULL。
//
// 运行（库里没有任何 schema 时脚本自己按文件名顺序套 `services/api/db/migrations/*.sql`）：
//   $env:DATABASE_URL='postgres://gengyun@127.0.0.1:55712/gengyun_w12_conc'
//   node --experimental-strip-types tests/integration/media-concurrency-pg.mjs
//   或 node --experimental-strip-types tests/integration/media-concurrency-pg.mjs <DATABASE_URL>
//
// 字节面用**替身桶**（`createSubstituteObjectStore`，进程内、零外呼），只把「事实面」压到真库：
// 本机没有可达的对象存储端点，这一点写进报告的「未取得项」。
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createSubstituteObjectStore } from '../../services/api/src/media/object-store.ts';
import {
  MEDIA_IDEMPOTENCY_PATHS,
  mediaIdempotencyKeyHash,
  mediaIdempotencyScope,
} from '../../services/api/src/media/store.ts';
import { createPostgresMediaStore } from '../../services/api/src/media/store-pg.ts';
import { createObjectRefCipher } from '../../services/api/src/media/object-ref-cipher.ts';
import { MEDIA_LIMITS } from '../../services/api/src/media/service.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { jpegWithExif } from '../media/_fixtures.mjs';

const OBJECT_REF_KEY = '3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e0f2a4b6c8d0e1f3a5b7c9d0e2f4a6b8c0d';
const DATABASE_URL =
  process.env.DATABASE_URL
  ?? (process.argv[2] !== undefined && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : 'postgres://gengyun@127.0.0.1:55712/gengyun_w12_conc');
const KEY = (name) => `media-conc-${name}-00001`;

const notes = [];
function note(line) {
  notes.push(line);
  console.log(line);
}

const url = new URL(DATABASE_URL);
assert.equal(url.hostname, '127.0.0.1', '本测试只允许回环地址');

const client = new pg.Client({ connectionString: url.href });
await client.connect();
const pool = new pg.Pool({ connectionString: url.href, max: 6 });
const q = async (text, params = []) => (await client.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];
const countOf = async (text, params = []) => Number((await one(text, params)).v);

const migrations = discoverMigrations();
const schemaPresent = (await one(`SELECT to_regclass('public.media') AS rel`)).rel !== null;
if (!schemaPresent) {
  const applied = await applyMigrations(client, migrations);
  note(`[0] 迁移自举：空库，applyMigrations 套用了 ${applied.applied.length} 个迁移（共 ${migrations.length} 个文件）`);
}
const ledgerCountFor = async (scope, key) => countOf(
  `SELECT count(*)::int AS v FROM public.idempotency_keys
    WHERE scope = $1 AND key_hash = decode($2, 'hex')`,
  [scope, mediaIdempotencyKeyHash(scope, key)],
);
// 库是复用的，而 `KEY()` 是确定性的：上轮留下的 media 行与台账行会让本轮读数串台
// （同名 scope+key 直接被回放、absolute 计数虚高）。所以每轮先清空 media 域三张表。
await q('DELETE FROM public.media_derivatives');
await q('DELETE FROM public.media');
await q('DELETE FROM public.idempotency_keys');

const apps = [];
const app = (options) => {
  const instance = buildApp(options);
  apps.push(instance);
  return instance;
};

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

try {
  // -------------------------------------------------------------------------
  // 准备：两个真实用户 + 两个真会话 + PG 仓储 + 替身桶（同一个底层桶，上面叠闸）
  // -------------------------------------------------------------------------
  const ownerId = (await one("INSERT INTO users (state) VALUES ('active') RETURNING id")).id;
  const strangerId = (await one("INSERT INTO users (state) VALUES ('active') RETURNING id")).id;
  const authStore = createPostgresAuthStore({ query: (text, params) => pool.query(text, params) });
  const sessionFor = async (userId) => {
    const token = randomBytes(32).toString('base64url');
    await authStore.createSession({
      userId,
      tokenHashHex: hashToken(token),
      authEpoch: 1,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      audience: 'user',
    });
    return token;
  };
  const ownerToken = await sessionFor(ownerId);
  const strangerToken = await sessionFor(strangerId);
  const headersOf = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  const cipher = createObjectRefCipher(OBJECT_REF_KEY);
  const pgStore = createPostgresMediaStore({ pool, cipher });
  const rawBucket = createSubstituteObjectStore();
  const baseConfig = {
    ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    sessionSigningKey: randomBytes(32).toString('hex'),
  };
  const makeApp = (bucket, clock = () => new Date()) => app({
    config: baseConfig,
    pool,
    store: authStore,
    mediaStore: pgStore,
    mediaObjectStore: bucket,
    now: clock,
  });

  // 桶闸①：`getObject` 齐到 2 个才一起放行（构造「两边都已读到旧快照」的窗口）。
  // 8s 兜底不是等待策略，而是**防止测试自己挂死**：超时后仍按真实结果断言，必红并打印到达数。
  const barrier = { armed: 0, arrivals: 0, timedOut: false, waiters: [] };
  const barrierBucket = {
    ...rawBucket,
    async getObject(key) {
      if (barrier.armed > 0) {
        barrier.armed -= 1;
        barrier.arrivals += 1;
        if (barrier.arrivals >= 2) {
          // 第二个到达者把先到的全部放行：两条 complete 同时离开闸门（不是各等各的）。
          for (const release of barrier.waiters) release();
          barrier.waiters = [];
        } else {
          await Promise.race([
            new Promise((release) => { barrier.waiters.push(release); }),
            delay(8000).then(() => { barrier.timedOut = true; }),
          ]);
        }
      }
      return rawBucket.getObject(key);
    },
  };
  // 桶闸②：`deleteObject` 单次拦截（构造「reject 的回收已发生、条件写还没落」的窗口）。
  let deleteGate = null;
  const gatedDeleteBucket = {
    ...rawBucket,
    async deleteObject(key) {
      const held = deleteGate;
      if (held !== null) {
        deleteGate = null;
        held.entered();
        await held.released;
      }
      return rawBucket.deleteObject(key);
    },
  };
  const armDeleteGate = () => {
    let enteredResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    let releasedResolve;
    const released = new Promise((resolve) => { releasedResolve = resolve; });
    deleteGate = { entered: enteredResolve, released };
    return { entered, release: releasedResolve };
  };

  const jpeg = jpegWithExif();
  const declared = { purpose: 'weed_recognition', mime: 'image/jpeg', bytes: jpeg.length, sha256: sha256Hex(jpeg) };
  const ownerActor = { ownerId, authEpoch: 1, sessionRef: randomUUID() };
  const strangerActor = { ownerId: strangerId, authEpoch: 1, sessionRef: randomUUID() };
  note(`[0] 合成 jpeg=${jpeg.length}B；owner=${ownerId.slice(0, 8)}…/stranger=${strangerId.slice(0, 8)}…；`
    + `库=${url.pathname.slice(1)}@${url.host}；迁移文件 ${migrations.length} 个`);

  const main = makeApp(barrierBucket);
  const service = main.mediaService;
  const putRaw = async (mediaId) => {
    const keys = await service.serverObjectKeys(mediaId);
    await rawBucket.putObject(keys.rawRef, jpeg, 'image/jpeg');
    return keys;
  };
  const completeUrl = (mediaId) => `/api/v1/media/uploads/${mediaId}/complete`;
  const body = { sha256: declared.sha256, bytes: declared.bytes };
  // 库是复用的（同名库可能留着上轮的行），所以 [C] 的前置条件只按本轮建过的 id 计数。
  const createdMediaIds = [];
  const countInitiatedOfRun = () => countOf(
    `SELECT count(*)::int AS v FROM public.media WHERE state = 'initiated' AND id = ANY($1::uuid[])`,
    [createdMediaIds],
  );

  // -------------------------------------------------------------------------
  // [A] 同一媒体对象两次并发 complete ⇒ 202 + 409
  // -------------------------------------------------------------------------
  const raceInit = await service.initiateUpload({ actor: ownerActor, input: declared, idempotencyKey: KEY('race-init') });
  const raceId = raceInit.media.id;
  createdMediaIds.push(raceId);
  const raceKeys = await putRaw(raceId);
  const keyA = KEY('race-complete-a');
  const keyB = KEY('race-complete-b');
  barrier.armed = 2;
  barrier.arrivals = 0;
  barrier.timedOut = false;
  const [raceA, raceB] = await Promise.all([
    main.inject({ method: 'POST', url: completeUrl(raceId), headers: { ...headersOf(ownerToken), 'idempotency-key': keyA, 'if-match': '"1"' }, payload: body }),
    main.inject({ method: 'POST', url: completeUrl(raceId), headers: { ...headersOf(ownerToken), 'idempotency-key': keyB, 'if-match': '"1"' }, payload: body }),
  ]);
  const raceStatuses = [raceA.statusCode, raceB.statusCode].sort((a, b) => a - b);
  note(`[A] 闸内到达数=${barrier.arrivals}（超时=${barrier.timedOut}）；两个 complete 的状态码=${JSON.stringify([raceA.statusCode, raceB.statusCode])}`);
  assert.equal(barrier.arrivals, 2, '两条 complete 都必须走到取字节那一步，否则窗口没构造出来');
  assert.deepEqual(raceStatuses, [202, 409], `并发 complete 必须是 (202, 409)，实际 ${JSON.stringify(raceStatuses)}`);
  const winner = raceA.statusCode === 202 ? raceA : raceB;
  const loser = raceA.statusCode === 409 ? raceA : raceB;
  const winnerKey = raceA.statusCode === 202 ? keyA : keyB;
  const loserKey = raceA.statusCode === 202 ? keyB : keyA;
  assert.equal(winner.json().data.state, 'ready');
  assert.equal(winner.json().data.revision, 2);
  assert.equal(loser.json().error.code, 'REVISION_CONFLICT', `409 的错误码必须是 REVISION_CONFLICT，实际 ${loser.json().error.code}`);
  note(`[A] 胜方 202：state=${winner.json().data.state} revision=${winner.json().data.revision}；`
    + `败方 409：${loser.json().error.code}／「${loser.json().error.message}」`);

  const raceRow = await one('SELECT state::text AS state, revision, failure_code FROM public.media WHERE id=$1', [raceId]);
  const raceDerivatives = await countOf('SELECT count(*)::int AS v FROM public.media_derivatives WHERE media_id=$1', [raceId]);
  const scopeComplete = mediaIdempotencyScope(ownerId, 'POST', MEDIA_IDEMPOTENCY_PATHS.complete);
  const winnerLedger = await ledgerCountFor(scopeComplete, winnerKey);
  const loserLedger = await ledgerCountFor(scopeComplete, loserKey);
  // 败方 complete 的 `dropObjects` 会把快照里的两个引用都回收（rawRef 与胜方共享）——这是**读数**，不是断言项。
  const rawAfterRace = await rawBucket.getObject(raceKeys.rawRef);
  note(`[A] 库内：media state=${raceRow.state} revision=${raceRow.revision} failure_code=${raceRow.failure_code ?? 'NULL'}；`
    + `media_derivatives=${raceDerivatives} 行`);
  note(`[A] 台账：胜方键行数=${winnerLedger}／败方键行数=${loserLedger}（败方占位已 release）；`
    + `共享原始对象赛后${rawAfterRace === null ? '已被回收（null）' : '仍在'}`);
  assert.equal(raceRow.state, 'ready');
  assert.equal(raceRow.revision, 2);
  assert.equal(raceDerivatives, 1, '并发 complete 只能留下一个衍生物行');
  assert.equal(winnerLedger, 1, '胜方必须留一条回执行供重放');
  assert.equal(loserLedger, 0, '败方占位必须 release，不得留悬空台账行');

  // -------------------------------------------------------------------------
  // [B1] 同一 key 跨主体 initiate ⇒ 两个 201、两条 media、两把独立 scope
  // -------------------------------------------------------------------------
  const sharedInitKey = KEY('shared-init');
  const ownerInit = await service.initiateUpload({ actor: ownerActor, input: declared, idempotencyKey: sharedInitKey });
  const strangerInit = await service.initiateUpload({ actor: strangerActor, input: declared, idempotencyKey: sharedInitKey });
  assert.equal(ownerInit.status, 201);
  assert.equal(strangerInit.status, 201);
  assert.notEqual(ownerInit.media.id, strangerInit.media.id, '跨主体同键不得复用同一条媒体');
  createdMediaIds.push(ownerInit.media.id, strangerInit.media.id);
  const scopeInitOwner = mediaIdempotencyScope(ownerId, 'POST', MEDIA_IDEMPOTENCY_PATHS.initiate);
  const scopeInitStranger = mediaIdempotencyScope(strangerId, 'POST', MEDIA_IDEMPOTENCY_PATHS.initiate);
  assert.notEqual(scopeInitOwner, scopeInitStranger, 'scope 必须含主体');
  const initLedger = await q(
    `SELECT scope, count(*)::int AS n FROM public.idempotency_keys
      WHERE scope = ANY($1::text[]) GROUP BY scope ORDER BY scope`,
    [[scopeInitOwner, scopeInitStranger]],
  );
  const ownerSharedRows = await ledgerCountFor(scopeInitOwner, sharedInitKey);
  const strangerSharedRows = await ledgerCountFor(scopeInitStranger, sharedInitKey);
  const sharedOwnerRow = await one('SELECT owner_id FROM public.media WHERE id=$1', [ownerInit.media.id]);
  const sharedStrangerRow = await one('SELECT owner_id FROM public.media WHERE id=$1', [strangerInit.media.id]);
  note(`[B1] 同一 key「${sharedInitKey}」：owner→${ownerInit.status}/${ownerInit.media.id.slice(0, 8)}…，`
    + `stranger→${strangerInit.status}/${strangerInit.media.id.slice(0, 8)}…；`
    + `该键在 owner scope=${ownerSharedRows} 行／stranger scope=${strangerSharedRows} 行`);
  note(`[B1] 库内归属：owner 对象 owner_id=${sharedOwnerRow.owner_id.slice(0, 8)}…／`
    + `stranger 对象 owner_id=${sharedStrangerRow.owner_id.slice(0, 8)}…（各自主体，两把 scope 互不抑制）`);
  assert.equal(initLedger.length, 2, '两个主体必须各占一行台账（scope 不同）');
  assert.equal(ownerSharedRows, 1, '同一 key 在两个 scope 各落一次');
  assert.equal(strangerSharedRows, 1);
  assert.equal(sharedOwnerRow.owner_id, ownerId);
  assert.equal(sharedStrangerRow.owner_id, strangerId);

  // -------------------------------------------------------------------------
  // [B2] 同一 key 同一媒体、换主体 complete ⇒ 404（不回放他人回执、不在对方 scope 留行）
  // -------------------------------------------------------------------------
  const sharedCompleteKey = KEY('shared-complete');
  const ownerMediaId = ownerInit.media.id;
  await putRaw(ownerMediaId);
  const ownerComplete = await main.inject({
    method: 'POST',
    url: completeUrl(ownerMediaId),
    headers: { ...headersOf(ownerToken), 'idempotency-key': sharedCompleteKey, 'if-match': '"1"' },
    payload: body,
  });
  assert.equal(ownerComplete.statusCode, 202, JSON.stringify(ownerComplete.json()));
  const strangerComplete = await main.inject({
    method: 'POST',
    url: completeUrl(ownerMediaId),
    headers: { ...headersOf(strangerToken), 'idempotency-key': sharedCompleteKey, 'if-match': '"2"' },
    payload: body,
  });
  const replayComplete = await main.inject({
    method: 'POST',
    url: completeUrl(ownerMediaId),
    headers: { ...headersOf(ownerToken), 'idempotency-key': sharedCompleteKey, 'if-match': '"1"' },
    payload: body,
  });
  const scopeCompleteStranger = mediaIdempotencyScope(strangerId, 'POST', MEDIA_IDEMPOTENCY_PATHS.complete);
  const strangerLedger = await ledgerCountFor(scopeCompleteStranger, sharedCompleteKey);
  const ownerLedger = await ledgerCountFor(scopeComplete, sharedCompleteKey);
  note(`[B2] 同 key 同媒体：owner complete→${ownerComplete.statusCode}（replay→${replayComplete.statusCode}），`
    + `stranger complete→${strangerComplete.statusCode} ${strangerComplete.json().error?.code ?? ''}；`
    + `台账：owner scope=${ownerLedger} 行／stranger scope=${strangerLedger} 行`);
  assert.equal(strangerComplete.statusCode, 404, `跨主体必须 404（归属来自库），实际 ${strangerComplete.statusCode}`);
  assert.equal(strangerComplete.json().error.code, 'NOT_FOUND');
  assert.equal(replayComplete.statusCode, 202, '同主体同键同请求必须回放 202');
  assert.equal(replayComplete.json().data.id, ownerMediaId);
  assert.equal(strangerLedger, 0, '跨主体不得在对方 scope 留台账行（失败即 release）');
  assert.equal(ownerLedger, 1);

  // -------------------------------------------------------------------------
  // [B3] 对照：同主体同 key、换请求体 ⇒ 409 IDEMPOTENCY_CONFLICT（scope 相等才会撞）
  // -------------------------------------------------------------------------
  const sameSubjectKey = KEY('same-subject');
  const conflictInit = await service.initiateUpload({ actor: ownerActor, input: declared, idempotencyKey: KEY('conflict-init') });
  await putRaw(conflictInit.media.id);
  const firstComplete = await main.inject({
    method: 'POST',
    url: completeUrl(conflictInit.media.id),
    headers: { ...headersOf(ownerToken), 'idempotency-key': sameSubjectKey, 'if-match': '"1"' },
    payload: body,
  });
  const conflictingComplete = await main.inject({
    method: 'POST',
    url: completeUrl(conflictInit.media.id),
    headers: { ...headersOf(ownerToken), 'idempotency-key': sameSubjectKey, 'if-match': '"1"' },
    payload: { sha256: declared.sha256, bytes: declared.bytes - 1 },
  });
  note(`[B3] 同主体同 key 异请求体：首次→${firstComplete.statusCode}，改体→${conflictingComplete.statusCode} `
    + `${conflictingComplete.json().error?.code ?? ''}`);
  assert.equal(firstComplete.statusCode, 202);
  assert.equal(conflictingComplete.statusCode, 409);
  assert.equal(conflictingComplete.json().error.code, 'IDEMPOTENCY_CONFLICT');

  // -------------------------------------------------------------------------
  // 清场：把 B1 里 stranger 那条仍 initiated 的行删掉，[C] 的计数才可判定
  // -------------------------------------------------------------------------
  const cleanupB = await main.inject({
    method: 'DELETE',
    url: `/api/v1/media/${strangerInit.media.id}`,
    headers: { ...headersOf(strangerToken), 'idempotency-key': KEY('cleanup-b'), 'if-match': '"1"' },
  });
  assert.equal(cleanupB.statusCode, 202, JSON.stringify(cleanupB.json()));

  // -------------------------------------------------------------------------
  // [C1] reject() 返回 true：真过期落库（rejected/expired）
  // -------------------------------------------------------------------------
  const expireInit = await service.initiateUpload({ actor: ownerActor, input: declared, idempotencyKey: KEY('expire-init') });
  const expireId = expireInit.media.id;
  createdMediaIds.push(expireId);
  const initiatedBefore = await countInitiatedOfRun();
  assert.equal(initiatedBefore, 1, `[C] 窗口前置条件：此刻库内应只有一条 initiated，实际 ${initiatedBefore}`);
  const futureMs = Date.now() + MEDIA_LIMITS.initiatedTtlMs + 60_000;
  const expired = makeApp(rawBucket, () => new Date(futureMs));
  const expireResult = await expired.mediaService.expireInitiated();
  const expiredRow = await one('SELECT state::text AS state, revision, failure_code FROM public.media WHERE id=$1', [expireId]);
  note(`[C1] 未来时钟（now+TTL+60s）expireInitiated → expired=${expireResult.expired}（库内 initiated=${initiatedBefore}）；`
    + `行 state=${expiredRow.state} revision=${expiredRow.revision} failure_code=${expiredRow.failure_code}`);
  assert.equal(expireResult.expired, initiatedBefore, 'expired 计数必须等于真的把 rejected 落库的行数（reject 返回 true 才计数）');
  assert.equal(expiredRow.state, 'rejected');
  assert.equal(expiredRow.failure_code, 'expired');
  assert.equal(expiredRow.revision, 1);

  // -------------------------------------------------------------------------
  // [C2] reject() 返回 false：同一条行在窗口里被 delete 推进到 deleted/rev2
  // -------------------------------------------------------------------------
  const falseInit = await service.initiateUpload({ actor: ownerActor, input: declared, idempotencyKey: KEY('false-init') });
  const falseId = falseInit.media.id;
  createdMediaIds.push(falseId);
  const initiatedBeforeC2 = await countInitiatedOfRun();
  assert.equal(initiatedBeforeC2, 1, `[C2] 窗口前置条件：库内应只有一条 initiated，实际 ${initiatedBeforeC2}`);

  const expiringApp = makeApp(gatedDeleteBucket, () => new Date(futureMs));
  const gate = armDeleteGate();
  const expiring = expiringApp.mediaService.expireInitiated(); // 不 await：它会在 dropObjects 里停住
  await gate.entered;
  const deleteInWindow = await main.inject({
    method: 'DELETE',
    url: `/api/v1/media/${falseId}`,
    headers: { ...headersOf(ownerToken), 'idempotency-key': KEY('false-delete'), 'if-match': '"1"' },
  });
  assert.equal(deleteInWindow.statusCode, 202, JSON.stringify(deleteInWindow.json()));
  gate.release();
  const expiringResult = await expiring;
  const falseRow = await one('SELECT state::text AS state, revision, failure_code FROM public.media WHERE id=$1', [falseId]);
  note(`[C2] 窗口内 DELETE→${deleteInWindow.statusCode}（revision=${deleteInWindow.json().data.accepted ? 'accepted' : '?'}）；`
    + `放行后 expireInitiated → expired=${expiringResult.expired}；`
    + `行 state=${falseRow.state} revision=${falseRow.revision} failure_code=${falseRow.failure_code ?? 'NULL'}`);
  assert.equal(expiringResult.expired, 0, '条件写 0 行 ⇒ reject() 必须返回 false，不得计入 expired');
  assert.equal(falseRow.state, 'deleted', 'reject() 的 false 分支不得把 deleted 覆盖回 rejected');
  assert.equal(falseRow.revision, 2);
  assert.equal(falseRow.failure_code, null);

  // -------------------------------------------------------------------------
  // 汇总
  // -------------------------------------------------------------------------
  note('');
  note('=== 读数汇总（真 PG） ===');
  note(`A 并发 complete：${JSON.stringify([raceA.statusCode, raceB.statusCode])}（胜方 ${winnerKey} / 败方 ${loserKey}）；`
    + `库里 ready/rev${raceRow.revision}、衍生物 1 行、败方台账 0 行`);
  note(`B1 跨主体同键 initiate：201 + 201，两条 media，两把 scope 各 1 行`);
  note(`B2 跨主体同键 complete：owner 202 / stranger ${strangerComplete.statusCode}，stranger scope 0 行`);
  note(`B3 同主体异请求同键：409 IDEMPOTENCY_CONFLICT`);
  note(`C1 reject→true：expired=${expireResult.expired}，rejected/expired 落库`);
  note(`C2 reject→false：expired=${expiringResult.expired}，库里仍是 deleted/rev${falseRow.revision}`);
  console.log(`\n媒体域并发补测通过（真 PG ${url.host}/${url.pathname.slice(1)}）`);
} finally {
  for (const instance of apps) {
    try { await instance.close(); } catch { /* 关停失败不影响读数 */ }
  }
  try { await pool.end(); } catch { /* 同上 */ }
  try { await client.end(); } catch { /* 同上 */ }
}
