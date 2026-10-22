// GY-R28 W12 媒体持久化 · 接真实 PostgreSQL 17 的端到端证据。
//
// 本片要还的是 W2 留下的设计债：`services/api/src/media/**` 的三个事实源原本是进程内 `Map`
// （旧 `records`/`grants`/`idempotency` + `inflight`）——进程一退，上传句柄、幂等回执、社区授权
// 全部消失。现在它们经 `MediaStore` 端口落库（`services/api/src/media/store.ts` /
// `store-pg.ts`），幂等台账复用 0008 的 `public.idempotency_keys`（先例：
// `services/api/db/migrations/0019_messages_persistence.sql:28-29`）。
// **迁移号如实登记**：登记册/幂等台账原本不占新号；返修（监工 1022-0659 轮 P1「CAS=0 失利者的
// 清理线索丢失」）新增了 `0029_media_object_cleanup.sql`（清理台账）。`media` / `media_derivatives`
// 两张表的 DDL **仍然只出自 0001**，下面第 [1] 段的判据逐条核这件事，不看迁移号。
//
// 运行（本机隔离集群，库名不硬钉，但**必须是空库/专用库**）：
//   $env:DATABASE_URL='postgres://gengyun@127.0.0.1:55683/gengyun'
//   node --experimental-strip-types tests/integration/media-persistence-pg.mjs
//   或 node --experimental-strip-types tests/integration/media-persistence-pg.mjs <DATABASE_URL>
//
// 迁移自举：库里还没有 `schema_migrations` 时，本脚本自己按文件名顺序套用
// `services/api/db/migrations/*.sql`（与 `npm run db:migrate` 同一份文件），
// 因此 CI 里不需要额外的迁移步骤（对齐 `tests/integration/messages-pg.mjs` 的做法）。
//
// 覆盖的读数：
//   [1] 四表 + 幂等台账在库里的**真实形状**（列名/约束/唯一索引，逐条 SQL 查出来的）。
//   [2] 三段式入库：`media` 行的 `object_ref_cipher` 是**密文信封**（不是明文桶键）、
//       `media_derivatives` 行的衍生物同样是密文、状态机 initiated → ready、revision 1 → 2。
//   [3] 幂等：同键重复 `complete` ⇒ 202 回放，`media` 行数不变、`media_derivatives` 行数不变、
//       台账行数不变（**不重复计费/不重复派生**）；异请求同键 ⇒ 409 IDEMPOTENCY_CONFLICT。
//   [4] owner 私有读逐字节相等；非 owner 一律 NOT_FOUND（归属来自库，不是进程内）。
//   [5] **真重启（新进程）**：另一个 node 进程只凭库里的行 + 同一把键就能读回同一媒体，
//       对象键与重启前逐字相等。
//   [6] 装配层 fail-closed：`real` + 有连接池但没有 `MEDIA_OBJECT_REF_KEY` ⇒ 媒体域整域 503，
//       `failClosedReason` 点名缺的配置键（**不**静默退回进程内登记册）。
//   [7] 有键的正向对照：同一 real 装配能从库里读到 [2] 写下的行（证明 app.ts 接的是 PG 仓储）。
//   [8] 负控制：把端口换成「空实现」⇒ 同一路径必须变红（NOT_FOUND），报错文本原样打印。
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import {
  createSubstituteObjectStore,
  createS3CompatibleObjectStore,
} from '../../services/api/src/media/object-store.ts';
import {
  MEDIA_IDEMPOTENCY_PATHS,
  mediaIdempotencyKeyHash,
  mediaIdempotencyScope,
} from '../../services/api/src/media/store.ts';
import { createPostgresMediaStore } from '../../services/api/src/media/store-pg.ts';
import { createObjectRefCipher } from '../../services/api/src/media/object-ref-cipher.ts';
import {
  approveRealMediaWiring,
  createAppMediaService,
  readOwnerMediaContent,
} from '../../services/api/src/media/service.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { jpegWithExif } from '../media/_fixtures.mjs';

const OBJECT_REF_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f01a2b4c5d6e7f8091a2b3c4d5e6f70819';
// argv[2] 只在「不是开关」时当作连接串（`--child-read` 也是一个 argv）。
const DATABASE_URL =
  process.env.DATABASE_URL
  ?? (process.argv[2] !== undefined && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : 'postgres://gengyun@127.0.0.1:55683/gengyun');
const KEY = (name) => `media-pg-${name}-00000`;

const notes = [];
function note(line) {
  notes.push(line);
  console.log(line);
}
function unavailable(label, why) {
  note(`未取得 ${label}：${why}`);
}

// ---------------------------------------------------------------------------
// 子进程模式：**真重启**（另一个 node 进程，只有库 + 键，没有父进程的任何内存状态）
// ---------------------------------------------------------------------------
if (process.argv.includes('--child-read')) {
  const mediaIdIndex = process.argv.indexOf('--child-read') + 1;
  const mediaId = process.argv[mediaIdIndex];
  const outFile = process.argv[mediaIdIndex + 1];
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const cipher = createObjectRefCipher(OBJECT_REF_KEY);
    const store = createPostgresMediaStore({ pool, cipher });
    const record = await store.getMedia(mediaId);
    const service = createAppMediaService({
      executionMode: 'stub',
      objectStore: createSubstituteObjectStore(),
      tokenSecret: randomBytes(32).toString('hex'),
      persistence: store,
      now: () => new Date(),
    });
    const keys = await service.serverObjectKeys(mediaId);
    writeFileSync(
      outFile,
      JSON.stringify({
        pid: process.pid,
        record: record === null ? null : {
          state: record.state,
          revision: record.revision,
          sha256: record.sha256,
          bytes: record.bytes,
          rawRef: record.rawRef,
          derivativeRef: record.derivativeRef,
        },
        keys,
      }),
      'utf8',
    );
  } finally {
    await pool.end();
  }
  process.exit(0);
}

const url = new URL(DATABASE_URL);
assert.equal(url.hostname, '127.0.0.1', '本测试只允许回环地址');

const owner = new pg.Client({ connectionString: url.href });
await owner.connect();
const pool = new pg.Pool({ connectionString: url.href, max: 4 });
const q = async (text, params = []) => (await owner.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];
const countOf = async (text, params = []) => Number((await one(text, params)).v);

// 迁移自举：空库（CI 每步都 `CREATE DATABASE`）时用**仓库自带的迁移执行器**套用
// `services/api/db/migrations/*.sql`（与 `npm run db:migrate` 同一条代码路径：独立事务、
// 写 `schema_migrations` 台账与校验和、advisory lock），非空库原样复用。
const migrations = discoverMigrations();
const schemaPresent = (await one(`SELECT to_regclass('public.media') AS rel`)).rel !== null;
if (!schemaPresent) {
  const applied = await applyMigrations(owner, migrations);
  note(`[1] 迁移自举：空库，applyMigrations 套用了 ${applied.applied.length} 个迁移`);
}

const apps = [];
const app = (options) => {
  const instance = buildApp(options);
  apps.push(instance);
  return instance;
};

try {
  // -------------------------------------------------------------------------
  // [1] 事实盘：库里的四张媒体表 + 幂等台账
  // -------------------------------------------------------------------------
  const tables = await q(
    `SELECT table_name, count(*)::int AS columns
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('media','media_derivatives','content_media_refs','community_media_grants','idempotency_keys')
      GROUP BY table_name ORDER BY table_name`,
  );
  const tableNames = tables.map((row) => row.table_name);
  for (const required of ['media', 'media_derivatives', 'community_media_grants', 'idempotency_keys', 'content_media_refs']) {
    assert.ok(tableNames.includes(required), `缺表 ${required}（现场：${tableNames.join(',')}）`);
  }
  const mediaColumns = await q(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='media' ORDER BY ordinal_position`,
  );
  note(
    `[1] 表：${tables.map((row) => `${row.table_name}(${row.columns})`).join(' ')}；`
      + `media.object_ref_cipher=${
        mediaColumns.find((column) => column.column_name === 'object_ref_cipher')?.data_type
      }/${mediaColumns.find((column) => column.column_name === 'object_ref_cipher')?.is_nullable === 'NO' ? 'NOT NULL' : 'nullable'}`,
  );
  assert.equal(
    mediaColumns.some((column) => column.column_name === 'metadata_removed'),
    false,
    'media 表没有 metadata_removed 列（因此服务层不再假装持久化它）',
  );
  const migrationCount = (await q(
    `SELECT count(*)::int AS v FROM schema_migrations`,
  ).catch(() => [{ v: -1 }]))[0].v;
  note(
    `[1] schema_migrations 行数=${migrationCount}；迁移文件 ${migrations.length} 个`
      + `（最大号 ${migrations.at(-1)?.filename}；本片返修只新增 0029 的清理台账，`
      + `media／media_derivatives 的 DDL 仍只出自 0001，判据见下）`,
  );
  assert.equal(migrationCount, migrations.length, 'schema_migrations 行数应等于迁移文件数');
  // ⛔ 旧判据钉的是「不存在 `/^0027_/` 的文件」——它其实想说「本片没占别人的迁移号」，但写法
  // 把**别人的迁移号**当成了自己的不变量：main 上 #428 合入 `0027_admin_audit_observability.sql` 后它恒红，
  // 且下一张 PR 拿 0028 会再红一次（同一个坑，只能靠反复改断言过活）。
  // 新判据看**迁移内容**，不看迁移号：media 域两张表（media／media_derivatives）的 DDL **只能出自 0001**。
  //   · 别人加 0027／0028／0030…（不碰这两张表）⇒ 不红，本判据不需要跟着别人改；
  //   · 真有片往 media 域叠迁移（`CREATE/ALTER/DROP TABLE|INDEX`，不管文件名里有没有 `media`）⇒ 立刻红，
  //     那时必须在本行显式登记文件名并写明是哪个片在改——这是「刻意留 diff」，不是靠号段猜。
  //   · 只认 DDL 的**作用对象**：别的表里带 `media_id` 外键／列的迁移（如 0018 的 favorites/history）不算。
  //   · 0029_media_object_cleanup.sql 建的是一张**新表**（清理台账），不碰这两张表 ⇒ 本判据照旧放行。
  const ddlTargetOf = (statement) => {
    if (/^create\s+(?:unique\s+)?index\b/i.test(statement)) {
      const on = /\bon\s+(?:only\s+)?(?:public\.)?([a-z_]+)/i.exec(statement);
      return on === null ? null : on[1].toLowerCase();
    }
    const head = /^(?:create\s+(?:unique\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?|alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?|drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?)([a-z_]+)/i.exec(statement);
    return head === null ? null : head[1].toLowerCase();
  };
  const MEDIA_DOMAIN_TABLES = new Set(['media', 'media_derivatives']);
  const mediaDdlOwners = migrations
    .filter((migration) => migration.sql
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((statement) => statement.replace(/\s+/g, ' ').trim())
      .filter((statement) => /^(create|alter|drop)\b/i.test(statement))
      .some((statement) => MEDIA_DOMAIN_TABLES.has(ddlTargetOf(statement))))
    .map((migration) => migration.filename);
  assert.deepEqual(
    mediaDdlOwners,
    ['0001_initial_schema.sql'],
    'media 域 DDL 归属：media／media_derivatives 的 DDL 必须只出自 0001（本片返修只新增 0029 的清理台账，不动这两张表）。'
      + '这里多出文件名 ⇒ 有片在改 media 域：请在本断言显式登记该文件名并写明理由，⛔ 不要改回按迁移号判断。',
  );

  // -------------------------------------------------------------------------
  // 准备：两个真实用户 + 服务（stub 装配 + 显式注入 PG 仓储 + 替身桶）
  //   为什么字节面用替身桶：本测试只验**事实面**（登记册/授权/台账/密文列）在真 PG 里，
  //   对象字节不落真桶（不外呼任何供应商）。这一点在报告的「未取得项」里写清。
  // -------------------------------------------------------------------------
  const ownerId = (await one("INSERT INTO users (state) VALUES ('active') RETURNING id")).id;
  const strangerId = (await one("INSERT INTO users (state) VALUES ('active') RETURNING id")).id;
  const ownerActor = { ownerId, authEpoch: 1, sessionRef: randomUUID() };
  const strangerActor = { ownerId: strangerId, authEpoch: 1, sessionRef: randomUUID() };
  const tokenSecret = randomBytes(32).toString('hex');
  const cipher = createObjectRefCipher(OBJECT_REF_KEY);
  const pgStore = createPostgresMediaStore({ pool, cipher });
  const bucket = createSubstituteObjectStore();
  const service = createAppMediaService({
    executionMode: 'stub',
    objectStore: bucket,
    tokenSecret,
    persistence: pgStore,
    now: () => new Date(),
  });
  const jpeg = jpegWithExif();
  const declared = { purpose: 'weed_recognition', mime: 'image/jpeg', bytes: jpeg.length, sha256: sha256Hex(jpeg) };
  note(`[0] 合成 jpeg=${jpeg.length}B（含 EXIF+GPS 的夹具）`);

  // -------------------------------------------------------------------------
  // [2] 三段式入库：initiate → 客户端 PUT → complete
  // -------------------------------------------------------------------------
  const initiated = await service.initiateUpload({
    actor: ownerActor,
    input: declared,
    idempotencyKey: KEY('initiate'),
  });
  const mediaId = initiated.media.id;
  assert.equal(initiated.status, 201);
  assert.equal(initiated.media.state, 'initiated');
  const initiatedKeys = await service.serverObjectKeys(mediaId);
  assert.equal(typeof initiatedKeys.rawRef, 'string');
  const rawRow = await one('SELECT object_ref_cipher, state, revision, sha256, bytes FROM media WHERE id=$1', [mediaId]);
  assert.match(rawRow.object_ref_cipher, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/, 'object_ref_cipher 必须是 v1 信封');
  assert.ok(!rawRow.object_ref_cipher.includes(initiatedKeys.rawRef), '密文列里不得出现明文桶键');
  assert.equal(cipher.decryptObjectRef(rawRow.object_ref_cipher), initiatedKeys.rawRef, '密文必须能被同一把键解回桶键');
  note(`[2] initiate：HTTP 201；media 行已落库 state=${rawRow.state} revision=${rawRow.revision}；`
    + `object_ref_cipher 长度=${rawRow.object_ref_cipher.length}（密文，解密回桶键一致）`);

  await bucket.putObject(initiatedKeys.rawRef, jpeg, 'image/jpeg');
  const completed = await service.completeUpload({
    actor: ownerActor,
    mediaId,
    ifMatch: '"1"',
    input: { sha256: declared.sha256, bytes: declared.bytes },
    idempotencyKey: KEY('complete'),
  });
  assert.equal(completed.status, 202);
  assert.equal(completed.media.state, 'ready');
  assert.equal(completed.media.revision, 2);
  const readyRow = await one('SELECT state, revision FROM media WHERE id=$1', [mediaId]);
  assert.equal(readyRow.state, 'ready');
  assert.equal(readyRow.revision, 2);
  const derivatives = await q(
    'SELECT derivative_kind, object_ref_cipher, hash, state FROM media_derivatives WHERE media_id=$1',
    [mediaId],
  );
  assert.equal(derivatives.length, 1, 'complete 必须且只落一个衍生物');
  assert.equal(derivatives[0].derivative_kind, 'metadata_stripped');
  assert.equal(derivatives[0].state, 'ready');
  assert.match(derivatives[0].object_ref_cipher, /^v1\./, '衍生物对象键同样是密文');
  const keysAfterComplete = await service.serverObjectKeys(mediaId);
  assert.notEqual(keysAfterComplete.rawRef, keysAfterComplete.derivativeRef);
  assert.equal(cipher.decryptObjectRef(derivatives[0].object_ref_cipher), keysAfterComplete.derivativeRef);
  note(`[2] complete：HTTP 202；media state=${readyRow.state} revision=${readyRow.revision}；`
    + `media_derivatives=1 行 kind=${derivatives[0].derivative_kind} hash=${derivatives[0].hash.slice(0, 12)}…`);
  note(`[2] rawRef=${keysAfterComplete.rawRef.slice(0, 18)}… derivativeRef=${keysAfterComplete.derivativeRef.slice(0, 18)}…（两个不同对象键）`);

  // -------------------------------------------------------------------------
  // [3] 幂等：同键重复 complete（不新增行、不重复派生）；异请求同键 ⇒ 409
  // -------------------------------------------------------------------------
  const beforeCounts = {
    media: await countOf('SELECT count(*)::int AS v FROM media'),
    derivatives: await countOf('SELECT count(*)::int AS v FROM media_derivatives'),
    ledger: await countOf('SELECT count(*)::int AS v FROM idempotency_keys'),
  };
  // 客户端重试用的是**同一个请求**：同 If-Match、同体、同键（请求指纹包含 If-Match，
  // 换 If-Match 就不是重放而是新请求 —— 那会被判 IDEMPOTENCY_CONFLICT，见下面的反向用例）。
  const replay = await service.completeUpload({
    actor: ownerActor,
    mediaId,
    ifMatch: '"1"',
    input: { sha256: declared.sha256, bytes: declared.bytes },
    idempotencyKey: KEY('complete'),
  });
  assert.equal(replay.status, 202);
  assert.equal(replay.media.revision, 2);
  const afterCounts = {
    media: await countOf('SELECT count(*)::int AS v FROM media'),
    derivatives: await countOf('SELECT count(*)::int AS v FROM media_derivatives'),
    ledger: await countOf('SELECT count(*)::int AS v FROM idempotency_keys'),
  };
  assert.deepEqual(afterCounts, beforeCounts, '同键回放不得新增任何行');
  const scope = mediaIdempotencyScope(ownerId, 'POST', MEDIA_IDEMPOTENCY_PATHS.complete);
  const ledgerRow = await one(
    'SELECT response_status, outcome, (extract(epoch FROM expires_at)*1000)::bigint AS expires_at_ms FROM idempotency_keys WHERE scope=$1 AND key_hash=decode($2,\'hex\')',
    [scope, mediaIdempotencyKeyHash(scope, KEY('complete'))],
  );
  assert.equal(ledgerRow.response_status, 202);
  assert.equal(ledgerRow.outcome.media_id, mediaId, '台账 outcome 必须引用同一媒体');
  assert.ok(Number(ledgerRow.expires_at_ms) > Date.now(), '回执必须仍在有效期内');
  note(`[3] 同键重复 complete：202 回放；行数 ${JSON.stringify(beforeCounts)} → ${JSON.stringify(afterCounts)}（新增 0）`);

  await assert.rejects(
    () => service.completeUpload({
      actor: ownerActor,
      mediaId,
      ifMatch: '"2"',
      input: { sha256: 'f'.repeat(64), bytes: declared.bytes },
      idempotencyKey: KEY('complete'),
    }),
    (error) => {
      note(`[3] 异请求同键：${error.code} / ${error.message}`);
      assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
      return true;
    },
  );

  // -------------------------------------------------------------------------
  // [4] owner 私有读逐字节相等；非 owner NOT_FOUND
  // -------------------------------------------------------------------------
  const ownerRead = await readOwnerMediaContent(service, { actor: ownerActor, mediaId });
  const expectedDerivative = await bucket.getObject(keysAfterComplete.derivativeRef);
  assert.equal(ownerRead.source, 'derivative');
  assert.deepEqual(Buffer.from(ownerRead.bytes), Buffer.from(expectedDerivative.bytes), 'owner 读必须逐字节相等');
  assert.equal(ownerRead.revision, 2);
  note(`[4] owner 读：source=${ownerRead.source} contentType=${ownerRead.contentType} bytes=${ownerRead.bytes.length}（与衍生件逐字节相等）`);
  await assert.rejects(
    () => readOwnerMediaContent(service, { actor: strangerActor, mediaId }),
    (error) => {
      note(`[4] 非 owner 读：${error.code} / ${error.message}`);
      assert.equal(error.code, 'NOT_FOUND');
      return true;
    },
  );

  // -------------------------------------------------------------------------
  // [5] 真重启（新进程）：只有库 + 键，没有父进程内存
  // -------------------------------------------------------------------------
  const outFile = join(tmpdir(), `media-restart-${randomUUID()}.json`);
  const child = spawnSync(
    process.execPath,
    ['--experimental-strip-types', fileURLToPath(import.meta.url), '--child-read', mediaId, outFile],
    { env: { ...process.env, DATABASE_URL: url.href, MEDIA_OBJECT_REF_KEY: OBJECT_REF_KEY }, encoding: 'utf8' },
  );
  if (!existsSync(outFile)) {
    unavailable('[5] 真重启读数', `子进程未产出结果（status=${child.status} signal=${child.signal} stderr=${String(child.stderr).slice(0, 400)}）`);
    throw new Error('真重启子进程失败');
  }
  const restarted = JSON.parse(readFileSync(outFile, 'utf8'));
  rmSync(outFile, { force: true });
  assert.notEqual(restarted.pid, process.pid, '必须是另一个进程（真重启）');
  assert.equal(restarted.record.state, 'ready');
  assert.equal(restarted.record.revision, 2);
  assert.equal(restarted.record.sha256, declared.sha256);
  assert.deepEqual(restarted.keys, keysAfterComplete, '重启后对象键必须与重启前逐字相等');
  note(`[5] 真重启（子进程 pid=${restarted.pid}）：同一 uploadId 仍可读，state=${restarted.record.state} revision=${restarted.record.revision}，键逐字相等`);

  // -------------------------------------------------------------------------
  // [6]/[7] 装配层：缺键 fail-closed；有键时同一 real 装配读得到库里那行
  // -------------------------------------------------------------------------
  const syntheticRealStore = createS3CompatibleObjectStore({
    endpoint: 'https://cos.ap-shanghai.myqcloud.com',
    bucket: 'gengyun-media-placeholder',
    accessKey: 'synthetic-access-key-id',
    secretKey: 'synthetic-secret-key-value',
    region: 'ap-shanghai',
    forcePathStyle: false,
  });
  const authStore = createPostgresAuthStore({ query: (text, params) => pool.query(text, params) });
  const sessionToken = randomBytes(32).toString('base64url');
  await authStore.createSession({
    userId: ownerId,
    tokenHashHex: hashToken(sessionToken),
    authEpoch: 1,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });

  const realConfig = (mediaObjectRefKey) => ({
    ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    executionMode: 'real',
    sessionSigningKey: randomBytes(32).toString('hex'),
    mediaObjectRefKey,
  });
  const realOptions = (mediaObjectRefKey) => ({
    config: realConfig(mediaObjectRefKey),
    pool,
    mediaObjectStore: syntheticRealStore,
    realMediaApproval: approveRealMediaWiring({ reason: 'W12 集成测试：合成端点，零外呼' }),
    now: () => new Date(),
  });

  const withoutKey = app(realOptions(null));
  const refusal = withoutKey.mediaService.failClosedReason;
  assert.equal(typeof refusal, 'string', '缺 MEDIA_OBJECT_REF_KEY 时媒体域必须整域 fail-closed');
  assert.ok(refusal.includes('MEDIA_OBJECT_REF_KEY'), `failClosedReason 必须点名缺的键，实际：${refusal}`);
  // 探针用 GET：上传面在服务之前还有 `uploadConsent` 前置闸门（缺键时它先回 403），
  // 那会把「媒体域已经 fail-closed」这件事遮住，所以两者分开记读数。
  const consentFirst = await withoutKey.inject({
    method: 'POST',
    url: '/api/v1/media/uploads',
    headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json', 'idempotency-key': KEY('no-key') },
    payload: declared,
  });
  const refused = await withoutKey.inject({
    method: 'GET',
    url: `/api/v1/media/${mediaId}`,
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(refused.statusCode, 503, refused.body);
  const refusedBody = refused.json();
  assert.equal(refusedBody.error.code, 'PROVIDER_UNAVAILABLE');
  assert.ok(refusedBody.error.message.includes('MEDIA_OBJECT_REF_KEY'), refusedBody.error.message);
  note(`[6] 缺键 fail-closed：HTTP ${refused.statusCode} ${refusedBody.error.code} / 「${refusedBody.error.message}」；`
    + `failClosedReason=「${refusal}」`);
  note(`[6] 同一缺键实例的上传面：HTTP ${consentFirst.statusCode} ${consentFirst.json().error.code}（consent 前置闸门先拦，非降级）`);

  const withKey = app(realOptions(OBJECT_REF_KEY));
  assert.equal(withKey.mediaService.failClosedReason, null, '有键时不得 fail-closed');
  assert.equal(withKey.mediaService.objectStore.kind, 's3_compatible', '真实桶端口必须真接上（不是替身）');
  // 之所以不用 `stats()`：真实适配器不提供 list 权限，`countObjects` 会显式拒绝
  // （`PROVIDER_UNAVAILABLE`「真实适配器不提供对象计数」）——那是既有设计，不在本片范围。
  // 真正要证的是「app.ts 接的是 PG 仓储」：这条 media 行只存在于库里，
  // 内存实现只会回 null ⇒ 404。GET 200 就是装配成立的证据（[8] 是同一判据的反向对照）。
  const dbMediaCount = await countOf('SELECT count(*)::int AS v FROM media');
  const dbKeys = await one('SELECT object_ref_cipher FROM media WHERE id=$1', [mediaId]);
  const readBack = await withKey.inject({
    method: 'GET',
    url: `/api/v1/media/${mediaId}`,
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(readBack.statusCode, 200, readBack.body);
  assert.equal(readBack.json().data.state, 'ready');
  assert.equal(readBack.json().data.revision, 2);
  assert.equal(dbMediaCount >= 1, true);
  note(`[7] 有键正向对照：real 装配 GET /media/{id} → HTTP 200 state=${readBack.json().data.state} revision=${readBack.json().data.revision}；`
    + `该行只在库里（库内 media 共 ${dbMediaCount} 行，object_ref_cipher=${String(dbKeys.object_ref_cipher).slice(0, 12)}…）`);

  // -------------------------------------------------------------------------
  // [8] 负控制：把端口换成「空实现」⇒ 同一路径必须变红
  // -------------------------------------------------------------------------
  const emptyStore = {
    persistent: false,
    kind: 'memory',
    async createMedia() {},
    async saveMedia() {},
    async saveMediaIfCurrent() { return 0; },
    async getMedia() { return null; },
    async liveCommunityImageCount() { return 0; },
    async listMediaByState() { return []; },
    async countMedia() { return 0; },
    async createGrant() {},
    async getGrant() { return null; },
    async revokeGrantsForMedia() { return 0; },
    async listStaleGrants() { return []; },
    async deleteGrant() {},
    async countGrants() { return 0; },
    async findIdempotency() { return null; },
    async claimIdempotency() { return true; },
    async settleIdempotency() { return true; },
    async releaseIdempotency() {},
  };
  const hollow = createAppMediaService({
    executionMode: 'stub',
    objectStore: bucket,
    tokenSecret,
    persistence: emptyStore,
    now: () => new Date(),
  });
  await assert.rejects(
    () => hollow.getMedia({ actor: ownerActor, mediaId }),
    (error) => {
      note(`[8] 负控制（空端口）：getMedia → ${error.code} / ${error.message}`);
      assert.equal(error.code, 'NOT_FOUND');
      return true;
    },
  );
  assert.equal((await hollow.serverObjectKeys(mediaId)), null, '空端口下连对象键都读不到');
  note('[8] 负控制结论：同一 uploadId 在空端口下读不到 ⇒ 上面的 200/逐字节相等确实来自真库');

  // -------------------------------------------------------------------------
  // [9] 监工 1927 轮 P1：`delete` 已落库之后，迟到的 `complete` 必须是**可判定的失败**（真库读数）
  //   窗口构造：把 complete 的衍生件 putObject 闸住（此刻它已读到 rev1/initiated 快照，尚未写回），
  //   在窗口内用同一仓储完成 delete，再放行。判据三条：①迟到写入不落库（0 行）
  //   ②库里仍是 deleted/rev2，没有被整行覆写回 ready ③窗口里落下的衍生件与衍生行都被回收。
  // -------------------------------------------------------------------------
  const gatedBucket = createSubstituteObjectStore();
  let gate = null;
  const racingBucket = {
    ...gatedBucket,
    async putObject(key, bytes, contentType) {
      const held = gate;
      if (held !== null) {
        gate = null;
        held.entered(key);
        await held.released;
      }
      return gatedBucket.putObject(key, bytes, contentType);
    },
  };
  const racingService = createAppMediaService({
    executionMode: 'stub',
    objectStore: racingBucket,
    tokenSecret,
    persistence: pgStore,
    now: () => new Date(),
  });
  const raceInitiated = await racingService.initiateUpload({
    actor: ownerActor,
    input: declared,
    idempotencyKey: KEY('race-initiate'),
  });
  const raceId = raceInitiated.media.id;
  const raceKeys = await racingService.serverObjectKeys(raceId);
  await gatedBucket.putObject(raceKeys.rawRef, jpeg, 'image/jpeg');
  const raceRowBefore = await one('SELECT state, revision FROM media WHERE id=$1', [raceId]);
  assert.equal(raceRowBefore.state, 'initiated');
  assert.equal(raceRowBefore.revision, 1);

  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  gate = { entered, released };
  const lateComplete = racingService.completeUpload({
    actor: ownerActor,
    mediaId: raceId,
    ifMatch: '"1"',
    input: { sha256: declared.sha256, bytes: declared.bytes },
    idempotencyKey: KEY('race-complete'),
  });
  const raceDerivativeKey = await enteredPromise;
  assert.notEqual(raceDerivativeKey, raceKeys.rawRef, '窗口里落下的是衍生件，不是原图键');

  const raceDeleted = await racingService.deleteMedia({
    actor: ownerActor,
    mediaId: raceId,
    ifMatch: '"1"',
    idempotencyKey: KEY('race-delete'),
  });
  assert.equal(raceDeleted.status, 202, JSON.stringify(raceDeleted));
  const inWindow = await one('SELECT state, revision FROM media WHERE id=$1', [raceId]);
  assert.equal(inWindow.state, 'deleted');
  assert.equal(inWindow.revision, 2);

  release();
  const raceOutcome = await lateComplete.then(
    (value) => ({ ok: true, code: null, message: null }),
    (error) => ({ ok: false, code: error.code, message: error.message }),
  );
  assert.equal(raceOutcome.ok, false, '迟到的 complete 不得在真库上返回成功');
  assert.equal(raceOutcome.code, 'OBJECT_UNAVAILABLE');

  const afterRace = await one(
    `SELECT state, revision, object_ref_cipher FROM media WHERE id=$1`,
    [raceId],
  );
  assert.equal(afterRace.state, 'deleted', '已删除的媒体不得被迟到的 complete 复活');
  assert.equal(afterRace.revision, 2);
  // 删除会把原图键清空成墓碑（密文列的 NOT NULL 约束要求写空串的密文，解密回 null）。
  assert.equal(cipher.decryptObjectRef(afterRace.object_ref_cipher), null, '删除后原图键必须已清空（墓碑）');
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM media_derivatives WHERE media_id=$1', [raceId]),
    0,
    '迟到写入不得落衍生行',
  );
  assert.equal(await gatedBucket.getObject(raceDerivativeKey), null, '窗口里落下的衍生件必须被回收');
  note(`[9] 迟到 complete（真库）：窗口内 delete ⇒ HTTP ${raceDeleted.status}（库内 state=${inWindow.state} rev=${inWindow.revision}）；`
    + `放行后 ⇒ ${raceOutcome.code}「${raceOutcome.message}」；`
    + `最终库内 state=${afterRace.state} rev=${afterRace.revision}，media_derivatives 行数=0，衍生件已回收`);

  // -------------------------------------------------------------------------
  // [10] 监工 1022-0203 / 1022-0541 / 1022-0659 三轮 P1（同一阻塞项）：
  //      CAS=0 失利者的衍生件**桶侧删不掉**（端口返回 false）时，可重试的清理依据必须**真的落库**。
  //  判据（全部打在真表的字节上，不靠内存实现）：
  //    ① `media_object_cleanup` 出现且只有一行，解出的对象键 = 本次落下的衍生键，reason 为 CAS 冲突、
  //       attempts ≥ 1；
  //    ② 父行已是 deleted/rev2 且两个对象键都清空（= 线索在父行上已经无处可依）——行仍在；
  //    ③ **物理删掉父行**（模拟注销清理）后清理行**仍然在** ⇒ 证明没有外键级联（这是本表的存在理由）；
  //    ④ 桶恢复后 `cleanupOrphans()` 收敛：对象真的没了、清理行也被删掉；
  //    ⑤ 再扫一次幂等：不多删、不新造行。
  // -------------------------------------------------------------------------
  const failBucketInner = createSubstituteObjectStore();
  const unfailableKeys = new Set();
  let raceGate = null;
  const failBucket = {
    ...failBucketInner,
    async putObject(key, bytes, contentType) {
      const held = raceGate;
      if (held !== null) {
        raceGate = null;
        held.entered(key);
        await held.released;
      }
      return failBucketInner.putObject(key, bytes, contentType);
    },
    async deleteObject(key) {
      // 桶侧「未能确认删除」：端口契约里 false ≠ 成功。
      if (unfailableKeys.has(key)) return false;
      return failBucketInner.deleteObject(key);
    },
  };
  const failService = createAppMediaService({
    executionMode: 'stub',
    objectStore: failBucket,
    tokenSecret,
    persistence: pgStore,
    now: () => new Date(),
  });
  const failInitiated = await failService.initiateUpload({
    actor: ownerActor,
    input: declared,
    idempotencyKey: KEY('cleanup-initiate'),
  });
  const failMediaId = failInitiated.media.id;
  const failKeys = await failService.serverObjectKeys(failMediaId);
  await failBucketInner.putObject(failKeys.rawRef, jpeg, 'image/jpeg');

  let failEntered;
  const failEnteredPromise = new Promise((resolve) => { failEntered = resolve; });
  let failRelease;
  const failReleased = new Promise((resolve) => { failRelease = resolve; });
  raceGate = { entered: failEntered, released: failReleased };
  const failComplete = failService.completeUpload({
    actor: ownerActor,
    mediaId: failMediaId,
    ifMatch: '"1"',
    input: { sha256: declared.sha256, bytes: declared.bytes },
    idempotencyKey: KEY('cleanup-complete'),
  });
  const orphanKey = await failEnteredPromise;
  const failDeleted = await failService.deleteMedia({
    actor: ownerActor,
    mediaId: failMediaId,
    ifMatch: '"1"',
    idempotencyKey: KEY('cleanup-delete'),
  });
  assert.equal(failDeleted.status, 202, JSON.stringify(failDeleted));
  // 让「删掉衍生键」这件事无法确认，再放行迟到的 complete。
  unfailableKeys.add(orphanKey);
  failRelease();
  const failOutcome = await failComplete.then(
    () => ({ ok: true, code: null }),
    (error) => ({ ok: false, code: error.code }),
  );
  assert.equal(failOutcome.ok, false, 'CAS=0 的迟到 complete 不得返回成功');
  assert.equal(failOutcome.code, 'OBJECT_UNAVAILABLE');

  const cleanupRows = await q(
    `SELECT media_id, object_ref_cipher, reason, attempts
       FROM public.media_object_cleanup ORDER BY created_at`,
  );
  assert.equal(cleanupRows.length, 1, `清理台账应有且只有一行（实际 ${cleanupRows.length} 行）`);
  const cleanupRow = cleanupRows[0];
  assert.equal(cipher.decryptObjectRef(cleanupRow.object_ref_cipher), orphanKey, '台账里必须能解回那个未确认删除的对象键');
  assert.equal(cleanupRow.media_id, failMediaId);
  assert.equal(cleanupRow.reason, 'cas_conflict_complete');
  assert.ok(Number(cleanupRow.attempts) >= 1, `attempts 应 ≥1（实际 ${cleanupRow.attempts}）`);

  const tombstoneRow = await one(
    `SELECT state, revision, object_ref_cipher FROM media WHERE id=$1`,
    [failMediaId],
  );
  assert.equal(tombstoneRow.state, 'deleted');
  assert.equal(tombstoneRow.revision, 2);
  assert.equal(cipher.decryptObjectRef(tombstoneRow.object_ref_cipher), null, '父行原图键已清空（线索无处可依）');
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM media_derivatives WHERE media_id=$1', [failMediaId]),
    0,
    '父行衍生物行也已清空（线索无处可依）',
  );
  assert.notEqual(await failBucketInner.getObject(orphanKey), null, '此刻该对象确实还在桶里（复现前提）');

  // ③ 物理删父行（= 注销清理的等价动作）：清理行**不得**被级联删掉。
  await q('DELETE FROM public.media WHERE id=$1', [failMediaId]);
  assert.equal(await countOf('SELECT count(*)::int AS v FROM media WHERE id=$1', [failMediaId]), 0);
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.media_object_cleanup WHERE media_id=$1', [failMediaId]),
    1,
    '父行被物理删除后，待清理行必须仍在（本表刻意不建外键、不级联）',
  );

  // ④ 桶恢复 ⇒ 重试收敛。
  unfailableKeys.clear();
  const healed = await failService.cleanupOrphans();
  assert.equal(healed.removedObjects, 1, `坏桶恢复后应回收 1 个对象（实际 ${healed.removedObjects}）`);
  assert.equal(healed.pendingObjects, 0);
  assert.equal(await failBucketInner.getObject(orphanKey), null, '重试后对象必须已从桶里消失');
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.media_object_cleanup'),
    0,
    '确认删除成功后清理行必须被删掉',
  );

  // ⑤ 幂等：再扫一次不得重复计数、也不得新造行。
  const healedAgain = await failService.cleanupOrphans();
  assert.equal(healedAgain.removedObjects, 0);
  assert.equal(healedAgain.pendingObjects, 0);
  assert.equal(await countOf('SELECT count(*)::int AS v FROM public.media_object_cleanup'), 0);

  note(`[10] 清理台账（真库）：CAS=0 落下的衍生件桶删返回 false ⇒ media_object_cleanup 1 行`
    + `（reason=${cleanupRow.reason} attempts=${cleanupRow.attempts}）；父行 deleted/rev2 且引用清空、`
    + `物理删父行后该行仍在（无级联）；桶恢复后 cleanupOrphans ⇒ removed=${healed.removedObjects}`
    + ` pending=${healed.pendingObjects}、对象已删、台账 0 行；复扫 removed=${healedAgain.removedObjects}（幂等）`);

  console.log(`\n${notes.length} 条读数，全部断言通过。`);
} finally {
  for (const instance of apps) await instance.close();
  await pool.end();
  await owner.end();
}
