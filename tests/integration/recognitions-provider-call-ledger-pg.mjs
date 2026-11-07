// GY-R83 · `#1003` · 识别外发记账表接真实 PostgreSQL 17.11（迁移 0055）
//
// 首次实跑：2026-11-07，PostgreSQL 17.11（本机回环 `127.0.0.1:55400`），结果为 `[√] ALL PASS`，
// 读数见 `docs/verification/gy-r86-provider-call-ledger-pg-first-run-20261107.md`。该次实跑当场暴露出
// 两处**从未被执行过**的判据缺陷（都是判据写错、产品代码无缺陷），已在本文件内修正：
//   ① `[T]` 的 export_id 外键正则硬写 `REFERENCES public.exports(id)`，而 `pg_get_constraintdef`
//      在 `search_path` 能解析到 `public` 时输出 `REFERENCES exports(id)`（无 schema 限定词）；
//   ② `[R]` 期望回滚件抛 `G0019` 后没有 `ROLLBACK`，会话停在 aborted 状态，后续语句一律 25P02。
// 这两处说明「写了但没跑过」的判据不能算证据——本文件此后按实跑记账。R87（`#29` 尾巴）起本臂**已接线**：
// `.github/workflows/real-pg-integration.yml` 的 `real-pg-ledger-17.11` job 用 `services.postgres:17.11`（发布在
// `127.0.0.1:5432`，`POSTGRES_USER` 即超管）真跑它 —— 先建 `gengyun_provider_call_ledger_test` 再经 `argv[2]` 传连接串；
// 白名单条目已从「未接线（真缺口）」改成「已接线（workflow）」（`tests/unit/ci-integration-chain-structure.test.mjs`）。
//
// 运行（本机隔离集群，仅回环；**自带建库**，不需要事先 createdb）：
//   node tests/integration/recognitions-provider-call-ledger-pg.mjs postgres://postgres@127.0.0.1:<port>/postgres
//   （省略参数 ⇒ `postgres://postgres@127.0.0.1:5432/postgres`；库名硬钉为
//    `gengyun_provider_call_ledger_test`，脚本自己 `DROP DATABASE … WITH (FORCE)` 再 `CREATE`）
//
// 本脚本只讲一件事：**「哪次外发、烧了多少 token、用的是哪套剖面」是数据库给的**，不是应用自己
// 记账、自己相信。因此逐条钉数据库侧的判据：
//   [N] 迁移串：全量 `up` ⇒ `schema_migrations` 末项是 0055（本片新增），且 0055 之后没有别的行。
//   [T] 表形状：13 列的名字/类型/可空/varchar 长度逐列复述（含 `id uuid PK default gen_random_uuid()`、
//       `job_id uuid` **可空且无外键**、`export_id` 挂 `public.exports ON DELETE CASCADE`）。
//   [K] 约束面：8 条命名约束 + 主键在位；`UNIQUE (export_id, attempt)` 真的拦重复；`provider_call_ledger_job_idx`
//       是 `(job_id)` 上的普通索引。
//   [W] 写原语 `createProviderCallLedger(pool).record()`：单语句 `INSERT … SELECT COALESCE(MAX(attempt),0)+1
//       … RETURNING attempt` ⇒ 同一 `export_id` 的两次外发得到 attempt=1、2（序号由数据库派生，⛔ 应用不传）；
//       返回 `{attempt}`（RETURNING 回读，⛔ 不做「写完再 SELECT 一次」的二次读）；
//       带 `timeoutMs` 时同一条语句被包进 `BEGIN / SET LOCAL statement_timeout / COMMIT`（短预算路径，
//       默认装配就是这样写的：最坏增量 ≤1.5s，超时按 57014 折成 `PROVIDER_TIMEOUT`）；
//       `usage` 落成 jsonb 对象、`sent_at` 取传入值、`duration_ms` 是整数；
//       不存在的 `export_id` ⇒ 外键拒绝（23503）但**抛出的是契约错误** `PROVIDER_UNAVAILABLE`（不泄驱动原文）；
//       非 uuid 的 `export_id` ⇒ `INVALID_REQUEST`（装配错误，不是数据库故障）。
//   [C] CHECK 边界逐条（绕过应用收口、直接 SQL）：`domain` 闭集 / `invocation_state` 闭集（**没有** `blocked`）/
//       `attempt >= 1` / `capability` 1..40 / `duration_ms >= 0` / `usage` 必须是对象 / 两列版本串形状
//       （`@` **允许**：它是本片版本串自己的分隔符；空格拒绝）。
//   [G] 级联：删 `public.exports` 那一行 ⇒ 该 export 的记账行随之消失（⛔ 不靠应用清理）。
//   [A] 授权面：迁移本身**零 GRANT**（新角色直连 ⇒ SELECT/INSERT 都 42501）；
//       把 `20-login-roles.sql` 的 `#region gy-r83-provider-call-ledger-grant` **原文**（只把角色名换成本臂探针角色）
//       执行一遍 ⇒ 2 列 SELECT（`export_id` / `attempt`）/ 11 列 INSERT（含 `attempt` 子查询与
//       `RETURNING attempt`）全部成功；且该区**恰好**只授这两条（无 UPDATE/DELETE/TRUNCATE，
//       也不授整行读权：`SELECT id, domain …` 仍必须 42501）。
//   [R] 回滚件：表里有行 ⇒ `G0019 / PROVIDER_CALL_LEDGER_ROLLBACK_BLOCKED` 中止（⛔ 不静默丢记账）；
//       清空后 ⇒ 整表拆除（不用 IF EXISTS：缺表就跑说明迁移没落过盘）。
//
// ⛔ 本臂**不**判（别读成已覆盖）：运行时的真实角色 `gengyun_api_runtime` 是否被 provision 到位
//    （那由 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的 `runtime_provider_call_ledger_dml_exec`
//    探针在 deploy-sql-gate 里判）；也不判 HTTP 读面（本片不加）。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { createProviderCallLedger } from '../../services/api/src/privacy/provider-call-ledger-pg.ts';

const DB = 'gengyun_provider_call_ledger_test';
const MIGRATION = '0055_provider_call_ledger.sql';
const DOWN = 'migrations/rollback/0055_provider_call_ledger.down.sql';
const REGION = 'gy-r83-provider-call-ledger-grant';
const PROBE_ROLE = 'gy_r83_pcl_probe';

const serverUrl = new URL(process.argv[2] ?? 'postgres://postgres@127.0.0.1:5432/postgres');
assert.equal(serverUrl.hostname, '127.0.0.1', '本测试只允许回环地址');
serverUrl.pathname = '/postgres';
const dbUrl = new URL(serverUrl.href);
dbUrl.pathname = `/${DB}`;

const notes = [];
/**
 * 分段行计数（P2-1 的读数源）：只数判据段落行 `^\[[A-Z]\] `（`[N]/[T]/[K]/[W]/[C]/[G]/[A]/[R]`），
 * ⛔ 不数 `[√]` 那两行 —— 否则末尾自己那条读数会把计数抬高，正好掩盖「整段被删」。
 */
let segments = 0;
function note(line) {
  notes.push(line);
  if (/^\[[A-Z]\] /.test(line)) segments += 1;
  console.log(line);
}

const readSql = (rel) => readFileSync(new URL(`../../services/api/db/${rel}`, import.meta.url), 'utf8');
/** 部署脚本不在 `services/api/db/` 下，单独取（⛔ 不要用 `../` 拼到 readSql 里，路径会跑偏）。 */
const loginRolesSql = () => readFileSync(new URL('../../deploy/postgres-cvm/sql/20-login-roles.sql', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// 建库（自带）：重建一个干净的库，避免上一次的残留行/角色影响判据
// ---------------------------------------------------------------------------
const admin = new pg.Client({ connectionString: serverUrl.href });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();
note(`[N] 已重建空库 ${DB}（DROP … WITH (FORCE) ⇒ CREATE）`);

const owner = new pg.Client({ connectionString: dbUrl.href });
await owner.connect();
const pool = new pg.Pool({ connectionString: dbUrl.href });

const q = async (text, params = []) => (await owner.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];
const countOf = async (text, params = []) => Number((await one(text, params)).v);

let userId;
let exportId;
let jobId;

/** 直接 SQL 插一行（绕过应用收口 —— 用来证明「数据库自己也拦得住」）。 */
const INSERT_RAW = `INSERT INTO public.provider_call_ledger
  (domain, job_id, export_id, attempt, capability, provider_config_version, model_version,
   invocation_state, usage, sent_at, duration_ms)
  VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz, $11)`;

async function insertRaw(overrides = {}) {
  const row = {
    domain: 'recognition',
    job_id: jobId ?? null,
    export_id: exportId,
    attempt: 90,
    capability: 'weed',
    provider_config_version: 'openai-vision-v1#vision-model-test@1a2b3c4d',
    model_version: 'openai-vision-v1',
    invocation_state: 'sent',
    usage: '{"total_tokens":7}',
    sent_at: '2026-11-07T01:00:00.000Z',
    duration_ms: 12,
    ...overrides,
  };
  await owner.query(INSERT_RAW, [
    row.domain,
    row.job_id,
    row.export_id,
    row.attempt,
    row.capability,
    row.provider_config_version,
    row.model_version,
    row.invocation_state,
    row.usage,
    row.sent_at,
    row.duration_ms,
  ]);
}

/**
 * 断言某条判据真的拦：默认 `23514`（check_violation）。
 *
 * ⚠ 超长值先撞 `varchar(n)` 的长度限制（`22001` string_data_right_truncation）而不是 CHECK —— 两者都是
 * 「数据库拒了」，判据不该只认 23514（PGlite 实测：capability 41 字符 ⇒ 22001、版本串 81 字符 ⇒ 22001）。
 */
async function expectRejected(overrides, label, codes = ['23514']) {
  await assert.rejects(
    () => insertRaw(overrides),
    (error) => codes.includes(error.code),
    `${label}：必须被数据库拒（期望 ${codes.join('/')}）`,
  );
  note(`[C] ${label} ⇒ ${codes.join('/')} 拒绝`);
}

// ---------------------------------------------------------------------------
// [N] 迁移串：全量 up 到 0055
// ---------------------------------------------------------------------------
{
  const result = await applyMigrations(owner, discoverMigrations());
  assert.ok(result.applied.includes('0055'), `0055 必须在本次 applied 里（实际 ${result.applied.join(',')}）`);
  const last = await one('SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1');
  assert.equal(last.version, '0055', `schema_migrations 末项必须是 0055（实际 ${last.version}）`);
  assert.equal(last.name, 'provider_call_ledger', '末项的迁移名必须与本片迁移一致（文件名去掉号位与后缀）');
  assert.equal(await countOf("SELECT count(*)::int AS v FROM schema_migrations WHERE version > '0055'"), 0, '0055 之后不许有更新的迁移');
  note(`[N] 全量 up：applied=${result.applied.length} 条，schema_migrations 末项 = 0055（${MIGRATION}）`);
}

// ---------------------------------------------------------------------------
// [T] 表形状：13 列逐列复述
// ---------------------------------------------------------------------------
{
  const rows = await q(
    `SELECT column_name, data_type, is_nullable, character_maximum_length AS len, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'provider_call_ledger'
      ORDER BY ordinal_position`,
  );
  const expected = [
    ['id', 'uuid', 'NO', null],
    ['domain', 'text', 'NO', null],
    ['job_id', 'uuid', 'YES', null],
    ['export_id', 'uuid', 'NO', null],
    ['attempt', 'integer', 'NO', null],
    ['capability', 'character varying', 'NO', 40],
    ['provider_config_version', 'character varying', 'NO', 80],
    ['model_version', 'character varying', 'YES', 80],
    ['invocation_state', 'text', 'NO', null],
    ['usage', 'jsonb', 'YES', null],
    ['sent_at', 'timestamp with time zone', 'YES', null],
    ['duration_ms', 'integer', 'YES', null],
    ['created_at', 'timestamp with time zone', 'NO', null],
  ];
  assert.equal(rows.length, expected.length, `列数必须是 ${expected.length}（实际 ${rows.length}：${rows.map(r => r.column_name).join(',')}）`);
  for (const [index, [name, type, nullable, len]] of expected.entries()) {
    const row = rows[index];
    assert.equal(row.column_name, name, `第 ${index + 1} 列名`);
    assert.equal(row.data_type, type, `${name}.data_type`);
    assert.equal(row.is_nullable, nullable, `${name}.is_nullable`);
    assert.equal(row.len, len, `${name}.character_maximum_length`);
  }
  const idDefault = rows.find(r => r.column_name === 'id').column_default;
  assert.match(idDefault, /gen_random_uuid\(\)/, 'id 必须吃 gen_random_uuid() 默认值');
  assert.match(rows.find(r => r.column_name === 'created_at').column_default, /now\(\)/, 'created_at 必须有 now() 默认值');
  assert.equal(rows.find(r => r.column_name === 'attempt').column_default, null, 'attempt 必须**没有**默认值：序号由写语句派生');

  // `job_id` 上**不许**有外键（照 0050 先例：作业行可能晚于外发、也可能被清理，外键会把记账拖下水）。
  const jobFks = await q(
    `SELECT conname FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.provider_call_ledger'::regclass AND contype = 'f'
        AND pg_get_constraintdef(oid) ILIKE '%job_id%'`,
  );
  assert.equal(jobFks.length, 0, `job_id 上不许有外键（实际 ${JSON.stringify(jobFks)}）`);

  // `export_id` 的外键必须带 ON DELETE CASCADE。
  const exportFk = await one(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.provider_call_ledger'::regclass AND contype = 'f'
        AND pg_get_constraintdef(oid) ILIKE '%export_id%'`,
  );
  assert.ok(exportFk, 'export_id 必须有外键');
  // PostgreSQL 在 `search_path` 能解析到 `public` 时会省掉 schema 限定词（pg_get_constraintdef 输出
  // `REFERENCES exports(id)`，而建表语句写的是 `public.exports`），两种写法都必须接受。
  assert.match(exportFk.def, /REFERENCES (public\.)?exports\(id\) ON DELETE CASCADE/i, `export_id 外键必须是 ON DELETE CASCADE（实际 ${exportFk?.def}）`);
  note('[T] 13 列形状逐列一致；job_id 无外键；export_id → public.exports ON DELETE CASCADE');
}

// ---------------------------------------------------------------------------
// [K] 约束面与索引
// ---------------------------------------------------------------------------
{
  const constraints = await q(
    `SELECT conname, contype FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.provider_call_ledger'::regclass ORDER BY conname`,
  );
  const names = new Set(constraints.map(row => row.conname));
  for (const required of [
    'provider_call_ledger_pkey',
    'provider_call_ledger_domain_closed',
    'provider_call_ledger_attempt_positive',
    'provider_call_ledger_capability_length',
    'provider_call_ledger_version_shape',
    'provider_call_ledger_state_closed',
    'provider_call_ledger_duration_nonneg',
    'provider_call_ledger_usage_object',
    'provider_call_ledger_export_attempt_key',
  ]) {
    assert.ok(names.has(required), `缺约束 ${required}（实际 ${[...names].join(',')}）`);
  }
  const unique = constraints.find(row => row.conname === 'provider_call_ledger_export_attempt_key');
  assert.equal(unique.contype, 'u', '(export_id, attempt) 必须是 UNIQUE 约束');
  const index = await one(
    `SELECT indexdef FROM pg_catalog.pg_indexes
      WHERE schemaname = 'public' AND tablename = 'provider_call_ledger' AND indexname = 'provider_call_ledger_job_idx'`,
  );
  assert.ok(index, '缺索引 provider_call_ledger_job_idx');
  assert.match(index.indexdef, /\(job_id\)/, `索引必须是 (job_id)（实际 ${index.indexdef}）`);
  note(`[K] 9 条约束 + job_idx 在场（实际约束 ${constraints.length} 条）`);
}

// ---------------------------------------------------------------------------
// 夹具：一个用户 + 一个 exports 预留行（本表 export_id 的外键目标）
// ---------------------------------------------------------------------------
{
  userId = (await one('INSERT INTO public.users DEFAULT VALUES RETURNING id')).id;
  jobId = randomUUID();
  exportId = (
    await one(
      `INSERT INTO public.exports
         (user_id, object_type, object_id, object_revision, purpose, consent_epoch,
          recipient_id, recipient_config_version, auth_epoch)
       VALUES ($1, 'media', $2::uuid, 3, 'external_inference', 1, 'openai-vision', 'r83', 1)
       RETURNING id`,
      [userId, randomUUID()],
    )
  ).id;
  note(`[F] 夹具就绪：user=${userId.slice(0, 8)}… export=${exportId.slice(0, 8)}… job=${jobId.slice(0, 8)}…`);
}

// ---------------------------------------------------------------------------
// [W] 写原语：序号派生 + usage/sent_at/duration 落库 + 错误折叠
// ---------------------------------------------------------------------------
{
  const ledger = createProviderCallLedger(pool);
  assert.ok(ledger, 'createProviderCallLedger(pool) 必须返回可用写原语');
  assert.equal(createProviderCallLedger(null), null, '没有池 ⇒ 返回 null（不记账，⛔ 不伪造内存账本）');

  const sentAt = new Date('2026-11-07T01:02:03.000Z');
  const written = await ledger.record({
    domain: 'recognition',
    jobId,
    exportId,
    capability: 'weed',
    providerConfigVersion: 'openai-vision-v1#vision-model-test@1a2b3c4d',
    modelVersion: 'openai-vision-v1',
    invocationState: 'sent',
    usage: { prompt_tokens: 120, completion_tokens: 34, total_tokens: 154 },
    sentAt,
    durationMs: 431,
  });
  const first = await one('SELECT * FROM public.provider_call_ledger WHERE export_id = $1 ORDER BY attempt', [exportId]);
  assert.equal(first.attempt, 1, '第一次外发 attempt 必须是 1');
  assert.deepEqual(written, { attempt: 1 }, 'record() 必须把 RETURNING 的 attempt 直接回给调用方（⛔ 不二次读）');
  assert.equal(first.domain, 'recognition');
  assert.equal(first.capability, 'weed');
  assert.equal(first.invocation_state, 'sent');
  assert.equal(first.job_id, jobId, 'job_id 原样落库');
  assert.deepEqual(first.usage, { prompt_tokens: 120, completion_tokens: 34, total_tokens: 154 }, 'usage 必须落成 jsonb 对象');
  assert.equal(first.sent_at.toISOString(), sentAt.toISOString(), 'sent_at 取传入值（不是 now()）');
  assert.equal(first.duration_ms, 431);
  assert.equal(
    await countOf("SELECT count(*)::int AS v FROM public.provider_call_ledger WHERE jsonb_typeof(usage) = 'object'"),
    1,
    'usage 的 jsonb_typeof 必须是 object',
  );
  note('[W] record(sent) ⇒ attempt=1、usage jsonb 对象、sent_at/duration_ms 逐字落库');

  // 同一 export 的第二次外发（失败那一趟）：序号由 SQL 派生 ⇒ 2；失败恒不带 usage。
  // 这一笔走**短预算路径**（`timeoutMs` ⇒ BEGIN / SET LOCAL statement_timeout / COMMIT），
  // 顺带证明事务包裹不会改变「序号由数据库派生」这件事。
  const second = await ledger.record({
    domain: 'recognition',
    jobId: null,
    exportId,
    capability: 'weed',
    providerConfigVersion: 'openai-vision-v1',
    modelVersion: null,
    invocationState: 'send_failed',
    usage: null,
    sentAt: new Date('2026-11-07T01:05:00.000Z'),
    durationMs: 15000,
    timeoutMs: 1500,
  });
  assert.deepEqual(second, { attempt: 2 }, '短预算路径（BEGIN / SET LOCAL statement_timeout / COMMIT）下序号仍由数据库派生');
  const rows = await q('SELECT attempt, invocation_state, usage, job_id, model_version FROM public.provider_call_ledger WHERE export_id = $1 ORDER BY attempt', [exportId]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].attempt, 2, '第二次外发 attempt 必须由 `COALESCE(MAX(attempt),0)+1` 派生');
  assert.equal(rows[1].invocation_state, 'send_failed');
  assert.equal(rows[1].usage, null, 'send_failed 不许带 usage');
  assert.equal(rows[1].job_id, null);
  assert.equal(rows[1].model_version, null);
  note('[W] 同一 export 再记一笔 ⇒ attempt=2（序号由数据库派生，应用不传）；send_failed 的 usage 为 NULL');

  // 不存在的 export ⇒ 外键 23503，但**抛给调用方的是契约错误**（不泄驱动原文）。
  await assert.rejects(
    () => ledger.record({
      domain: 'recognition',
      jobId: null,
      exportId: randomUUID(),
      capability: 'weed',
      providerConfigVersion: 'openai-vision-v1',
      modelVersion: null,
      invocationState: 'sent',
      usage: null,
      sentAt: null,
      durationMs: null,
    }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(/foreign key|violates/i.test(String(error.message)), false, '⛔ 驱动原文不许进 message');
      return true;
    },
    '外键拒绝必须折成 PROVIDER_UNAVAILABLE',
  );
  // 非 uuid 的 export_id ⇒ 装配错误（INVALID_REQUEST），不是数据库故障。
  await assert.rejects(
    () => ledger.record({
      domain: 'recognition',
      jobId: null,
      exportId: 'not-a-uuid',
      capability: 'weed',
      providerConfigVersion: 'openai-vision-v1',
      modelVersion: null,
      invocationState: 'sent',
    }),
    (error) => error.code === 'INVALID_REQUEST',
    '非 uuid 的 export_id 必须是 INVALID_REQUEST',
  );
  note('[W] 外键拒绝 ⇒ PROVIDER_UNAVAILABLE（不带驱动原文）；非 uuid ⇒ INVALID_REQUEST');
}

// ---------------------------------------------------------------------------
// [C] CHECK 边界（绕过应用收口）
// ---------------------------------------------------------------------------
{
  await expectRejected({ domain: 'moderation' }, 'domain 闭集外（moderation）');
  await expectRejected({ invocation_state: 'blocked' }, 'invocation_state 闭集外（blocked —— 本表刻意没有）');
  await expectRejected({ attempt: 0 }, 'attempt=0');
  await expectRejected({ capability: '' }, 'capability 空串');
  await expectRejected({ capability: 'c'.repeat(41) }, 'capability 41 字符', ['23514', '22001']);
  await expectRejected({ duration_ms: -1 }, 'duration_ms=-1');
  await expectRejected({ usage: '[1,2,3]' }, 'usage 是数组');
  await expectRejected({ usage: '42' }, 'usage 是标量');
  await expectRejected({ provider_config_version: 'has space' }, '版本串含空格');
  await expectRejected({ provider_config_version: '' }, '版本串空串（NOT NULL + 形状）');
  await expectRejected({ model_version: 'has space' }, 'model_version 含空格');
  await expectRejected({ provider_config_version: 'a'.repeat(81) }, '版本串 81 字符', ['23514', '22001']);

  // 正向控制：`@` 是**允许**的（它是本片版本串自己的分隔符，与 0050 的字符类差这一个字符）。
  await insertRaw({ attempt: 91, provider_config_version: 'openai-vision-v1#vision-model-test@1a2b3c4d' });
  await insertRaw({ attempt: 92, provider_config_version: 'openai-vision-v1@1a2b3c4d' });
  note('[C] 正向控制：`@` 分隔的版本串被接受（0050 的字符类会拒它 —— 本表刻意多这一个字符）');

  // 重复 (export_id, attempt) ⇒ 23505。
  await assert.rejects(
    () => insertRaw({ attempt: 91 }),
    (error) => error.code === '23505',
    'UNIQUE (export_id, attempt) 必须拦重复',
  );
  note('[C] 重复 (export_id, attempt) ⇒ 23505 拒绝');
  await owner.query('DELETE FROM public.provider_call_ledger WHERE attempt IN (91, 92)');
}

// ---------------------------------------------------------------------------
// [G] 级联：删 exports 行 ⇒ 记账行随之消失
// ---------------------------------------------------------------------------
{
  assert.equal(await countOf('SELECT count(*)::int AS v FROM public.provider_call_ledger WHERE export_id = $1', [exportId]), 2);
  await owner.query('DELETE FROM public.exports WHERE id = $1', [exportId]);
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.provider_call_ledger'),
    0,
    '删 exports 行必须级联删掉记账行（⛔ 不靠应用清理）',
  );
  note('[G] 删 public.exports ⇒ 记账行级联消失（ON DELETE CASCADE 生效）');

  // 重建夹具供后续段落使用。
  exportId = (
    await one(
      `INSERT INTO public.exports
         (user_id, object_type, object_id, object_revision, purpose, consent_epoch,
          recipient_id, recipient_config_version, auth_epoch)
       VALUES ($1, 'media', $2::uuid, 4, 'external_inference', 1, 'openai-vision', 'r83', 1)
       RETURNING id`,
      [userId, randomUUID()],
    )
  ).id;
}

// ---------------------------------------------------------------------------
// [A] 授权面：迁移零 GRANT + 20-login-roles 的 region 原文刚好够用
// ---------------------------------------------------------------------------
{
  await owner.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
  await owner.query(`CREATE ROLE ${PROBE_ROLE} NOLOGIN`);

  const probe = new pg.Client({ connectionString: dbUrl.href });
  await probe.connect();
  try {
    await probe.query(`SET ROLE ${PROBE_ROLE}`);
    await assert.rejects(
      () => probe.query('SELECT id, domain FROM public.provider_call_ledger LIMIT 1'),
      (error) => error.code === '42501',
      '迁移本身零 GRANT：新角色 SELECT 必须 42501',
    );
    await assert.rejects(
      () => probe.query(
        `INSERT INTO public.provider_call_ledger
           (domain, export_id, attempt, capability, provider_config_version, invocation_state)
         VALUES ('recognition', $1::uuid, 1, 'weed', 'openai-vision-v1', 'sent')`,
        [exportId],
      ),
      (error) => error.code === '42501',
      '迁移本身零 GRANT：新角色 INSERT 必须 42501',
    );
    note('[A] 迁移零 GRANT 自证：新角色 SELECT / INSERT 都是 42501');

    // 把 20-login-roles.sql 的 region **原文**拿来执行（只把角色名换成本臂探针角色）。
    const provisioning = loginRolesSql();
    const start = provisioning.indexOf(`-- #region ${REGION}`);
    const end = provisioning.indexOf(`-- #endregion ${REGION}`);
    assert.ok(start >= 0 && end > start, `20-login-roles.sql 里必须有成对的 #region/#endregion ${REGION}`);
    const region = provisioning
      .slice(start, end)
      .split('\n')
      .filter(line => !line.trimStart().startsWith('--'))
      .join('\n')
      .replaceAll('gengyun_api_runtime', PROBE_ROLE);
    assert.ok(region.includes('GRANT SELECT'), '授权区必须含 GRANT SELECT');
    assert.ok(region.includes('GRANT INSERT'), '授权区必须含 GRANT INSERT');
    assert.equal(/GRANT\s+(UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)/i.test(region), false, '授权区不许出现 UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER');
    assert.equal(new RegExp(`REVOKE ALL ON TABLE public\\.provider_call_ledger FROM PUBLIC`).test(region), true, '授权区必须先 REVOKE … FROM PUBLIC');

    await probe.query('RESET ROLE');
    await owner.query(region);
    await probe.query(`SET ROLE ${PROBE_ROLE}`);

    // 2 列 SELECT 可用（列级读权 ⇒ `count(export_id)` 这种只碰已授列的聚合就行；
    // ⛔ 别在这里写 `count(*)`：那会把「表级读权」当成前提，掩盖列面收敛）。
    assert.equal((await probe.query('SELECT count(export_id)::int AS n FROM public.provider_call_ledger')).rows[0].n, 0);
    // 11 列 INSERT + 与写原语同形的 `attempt` 子查询 + `RETURNING attempt` 可用。
    const inserted = await probe.query(
      `INSERT INTO public.provider_call_ledger
         (domain, job_id, export_id, attempt, capability, provider_config_version,
          model_version, invocation_state, usage, sent_at, duration_ms)
       SELECT 'recognition', NULL::uuid, $1::uuid,
              COALESCE((SELECT MAX(attempt) FROM public.provider_call_ledger WHERE export_id = $1::uuid), 0) + 1,
              'weed', 'openai-vision-v1#vision-model-test@1a2b3c4d', NULL::varchar(80), 'sent',
              '{"total_tokens":9}'::jsonb, now(), 5
       RETURNING attempt`,
      [exportId],
    );
    assert.equal(inserted.rows[0].attempt, 1, 'region 授予的列面必须足够写原语那条单语句（含 attempt 子查询与 RETURNING attempt）');
    // ⛔ 也只授 (export_id, attempt) 两列：整行回读必须仍然 42501（多授一列 = 多一条本角色不需要的读路径）。
    await assert.rejects(
      () => probe.query('SELECT id, domain FROM public.provider_call_ledger LIMIT 1'),
      (error) => error.code === '42501',
      '授权区只授 (export_id, attempt) 两列：整行回读必须 42501',
    );
    // ⛔ 没授 UPDATE / DELETE：这两条必须仍然 42501。
    await assert.rejects(
      () => probe.query('UPDATE public.provider_call_ledger SET capability = capability'),
      (error) => error.code === '42501',
      '授权区不许授 UPDATE',
    );
    await assert.rejects(
      () => probe.query('DELETE FROM public.provider_call_ledger'),
      (error) => error.code === '42501',
      '授权区不许授 DELETE',
    );
    note('[A] region 原文（角色名替换后）执行 ⇒ 2 列 SELECT（export_id/attempt）+ 11 列 INSERT（含 attempt 子查询/RETURNING）成功；整行回读与 UPDATE/DELETE 仍 42501');
  } finally {
    await probe.end();
    await owner.query(`SET ROLE NONE`).catch(() => {});
    await owner.query(`DROP OWNED BY ${PROBE_ROLE}`).catch(() => {});
    await owner.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
  }
}

// ---------------------------------------------------------------------------
// [R] 回滚件：有行 ⇒ G0019 中止；清空后 ⇒ 整表拆除
// ---------------------------------------------------------------------------
{
  const ledgerRowsBefore = await countOf('SELECT count(*)::int AS v FROM public.provider_call_ledger');
  assert.ok(ledgerRowsBefore > 0, '回滚臂要求表里先有行');
  const downSql = readSql(DOWN);
  await assert.rejects(
    () => owner.query(downSql),
    (error) => {
      assert.equal(error.code, 'G0019', `回滚必须用 G0019 中止（实际 ${error.code}）`);
      assert.match(String(error.message), /PROVIDER_CALL_LEDGER_ROLLBACK_BLOCKED/);
      return true;
    },
    '有记账行时回滚必须中止（⛔ 不静默丢记账）',
  );
  // 回滚件自己开了 `BEGIN;`，异常路径既没有 COMMIT 也没有 ROLLBACK ⇒ 会话停在 aborted 状态，
  // 之后的任何语句都会 25P02。这里显式回滚，才能继续验证「中止后表还在」。
  await owner.query('ROLLBACK');
  assert.ok((await one("SELECT to_regclass('public.provider_call_ledger') AS o")).o && (await countOf('SELECT count(*)::int AS v FROM public.provider_call_ledger')) === ledgerRowsBefore, '中止后表与记账行必须原样还在（不是只剩空表/少行）');
  note('[R] 表里有行 ⇒ 回滚件以 G0019 / PROVIDER_CALL_LEDGER_ROLLBACK_BLOCKED 中止，表原样还在');

  await owner.query('DELETE FROM public.provider_call_ledger');
  await owner.query(downSql);
  assert.equal((await one("SELECT to_regclass('public.provider_call_ledger') AS o")).o, null, '清空后回滚必须整表拆除');
  assert.equal(
    (await one("SELECT count(*)::int AS v FROM pg_catalog.pg_indexes WHERE indexname = 'provider_call_ledger_job_idx'")).v,
    0,
    '索引随表消失',
  );
  note('[R] 清空后回滚 ⇒ 整表拆除（索引随表消失），不碰 exports / jobs / 0050');
}

await owner.end();
await pool.end();

// ---------------------------------------------------------------------------
// 段落计数闸（P2-1）：`[√] ALL PASS` 只证明「跑到了最后一行」，证明不了「每组判据都还在」。
// 反例（审查实测 M6）：把上面 `[R]` 回滚那组 32 行整段删掉 ⇒ 脚本照样 exit 0、照样打 `[√] ALL PASS`,
// 只剩 note 行数从 27 掉到 25。所以这里把「段落行条数」也变成断言语义：
// 低于基线即按「整段断言被删」判红，且读数先进日志（失败时也看得见实际条数）。
// 基线 27 = 2026-11-07 本机 PG 17.11 实跑实测（`grep -c '^\[[A-Z]\] '` ⇒ 27）。
// ⛔ 不要在下调这个数「凑绿」：它要挡的正是「悄悄少一组断言」。
const EXPECTED_SEGMENTS = 27;
note(`[√] 分段 ${segments}/${EXPECTED_SEGMENTS}`);
assert.ok(
  segments >= EXPECTED_SEGMENTS,
  `分段行只有 ${segments} 条，少于基线 ${EXPECTED_SEGMENTS}：疑似整段断言被删`,
);
note('[√] ALL PASS');
