/**
 * GY-I27（#29）第三片 · **合成域（普通话 TTS 朗读）外发账本**端到端验收（真 PG 17.11）。
 *
 * 本脚本**只追加**：它跑在 `tests/integration/egress-ledger-pg.mjs` 已经建好的库上
 * （该脚本需以 `EGRESS_LEDGER_KEEP=1` 运行：保留角色/表/既有导出行）。
 *
 * 运行（本机隔离集群，仅回环；不联网、不发任何真实第三方请求、不打印凭据）：
 *   EGRESS_LEDGER_TEST_URL='postgres://<owner>:<pw>@127.0.0.1:55433/gengyun_egress_test' \
 *   node tests/integration/egress-object-key-pg.mjs
 *
 * 覆盖（全部为**真库**读数）：
 *   A. 迁移 `0014_export_object_key`：新增 `exports.object_key varchar(128)` + 「uuid 与文本
 *      **恰好互斥**」CHECK；既有（0014 之前写入的）导出行**仍可读**且计数不变；
 *      约束与列级权限的真库行为（含最小权限角色可 INSERT 该列、**不可** UPDATE 该列）；
 *   B. `0014` 回滚 → 结构如实消失、既有行仍可读 → 重放成功、结构复现；
 *   C. 合成域**正控制**：real + 账本 + 授权齐备 ⇒ 预留成功、`markSent` 落账、载荷出站（测试内替身传输）；
 *      账本如实登记 `object_key`（`<正文类型>:<正文标识>`，1..128 文本）+ 全零哨兵 `object_id` + 仅 `external_inference` 必需用途；
 *   D. **负控制**：① 无预留就出站 ⇒ `OBJECT_UNAVAILABLE`；② 用途未授权 ⇒ `CONSENT_REQUIRED`；
 *      ③ 对象标识非法（空 / >128 / 非法字符 / 未登记）⇒ 拒绝；
 *   E. **多要授权回归钉子**：新维度**不得**要求 `recording`（只授 `external_inference` ⇒ 受理成功）；
 *   F. **默认仍失败关闭**：real 未接真实传输 ⇒ 受理处 503 `PROVIDER_UNAVAILABLE`(retryable)，
 *      且该用户**零账本行**（在任何账本变更之前拒绝）。
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { createSubstituteMediaPort, createUnwiredMediaPort } from '../../services/api/src/tts/media.ts';
import { createStubTtsProvider } from '../../services/api/src/tts/provider.ts';
import { createMemoryCheckedContentPort } from '../../services/api/src/tts/content.ts';
import { NON_MEDIA_DATA_TYPES, NON_MEDIA_REQUIRED_CONSENTS, MEDIA_PURPOSE_REQUIRED_CONSENTS } from '../../packages/privacy/constants.mjs';

const url = new URL(process.env.EGRESS_LEDGER_TEST_URL ?? '');
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'EGRESS_LEDGER_TEST_URL 必须是 postgres URL');
assert.equal(url.search, '');
assert.equal(url.hash, '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), '只允许回环地址');
assert.equal(url.pathname, '/gengyun_egress_test');

const loginName = 'gengyun_egress_test';
const owner = new pg.Client({ connectionString: url.href });
await owner.connect();
const key = randomBytes(32).toString('hex');
/**
 * 本次运行的夹具命名空间。本脚本**追加在既有库上**且会被反复重跑：
 * 登录端点的 `Idempotency-Key` 记录落在库里（`login-<code>`），若两次运行的 key 相同而
 * 请求体哈希不同（每次运行的会话签名密钥都是随机的），第二次会被 409 `IDEMPOTENCY_CONFLICT` 拒。
 * 因此所有夹具 code 都带本次运行的随机后缀。
 */
const RUN = randomBytes(4).toString('hex');
const fx = (name) => `${name}-${RUN}`;
const subject = (code) => createHmac('sha256', key).update(`synthetic\n${code}`).digest('hex');
const sqlFile = (path) => readFileSync(new URL(`../../services/api/db/${path}`, import.meta.url), 'utf8');

let app;
let pool;
let passed = 0;
const say = (label) => {
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
};
const expectReject = async (promise, code, label) => {
  await assert.rejects(promise, (error) => error.code === code, `${label}：期望 ${code}`);
};

const userIdOf = async (code) =>
  (await owner.query('SELECT id FROM users WHERE wechat_subject_lookup=decode($1,\'hex\')', [subject(code)])).rows[0].id;
const exportRowsFor = async (userId) =>
  (await owner.query('SELECT * FROM exports WHERE user_id=$1 ORDER BY created_at ASC', [userId])).rows;
const exportRowFor = async (userId) =>
  (await owner.query('SELECT * FROM exports WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [userId])).rows[0] ?? null;
const writebackCount = async (exportId) =>
  Number((await owner.query('SELECT count(*)::int n FROM export_writebacks WHERE export_id=$1', [exportId])).rows[0].n);
const writebackFor = async (exportId) =>
  (await owner.query('SELECT * FROM export_writebacks WHERE export_id=$1', [exportId])).rows[0] ?? null;

function psqlBin() {
  const candidates = [
    process.env.W116_PSQL,
    'E:\\GengYunCommander\\.pg17\\adv-i27\\pgslim\\pgsql\\bin\\psql.exe',
    'E:\\GengYunCommander\\.pg17\\pgsql\\bin\\psql.exe',
  ].filter((value) => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      /* 继续找 */
    }
  }
  throw new Error('找不到 psql.exe（可用 W116_PSQL 指定）');
}

/** 以**运维连接**（owner）执行一个迁移/回滚 SQL 文件，返回 psql 的原始输出（实测读数）。 */
function psqlFile(relPath) {
  const file = fileURLToPath(new URL(`../../services/api/db/${relPath}`, import.meta.url));
  const args = ['-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username), '-d', 'gengyun_egress_test', '-v', 'ON_ERROR_STOP=1', '-tA', '-f', file];
  return execFileSync(psqlBin(), args, { encoding: 'utf8', env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) } }).trim();
}

/** 合成 real 传输（**测试内**；不联网）：包住替身提供者，记录每次调用入参。 */
function syntheticTtsTransport() {
  const inner = createStubTtsProvider({ executionMode: 'stub' });
  const calls = [];
  return {
    calls,
    provider: {
      // 执行模式标为 real：本脚本要覆盖的就是「real 模式下的账本派发」。
      executionMode: 'real',
      providerVersion: 'synthetic-test-transport-v1',
      note: '测试内合成 real 传输（不联网、不调用任何第三方）；仅用于驱动账本派发',
      available: true,
      unavailableReason: null,
      async synthesize(input) {
        calls.push(input);
        return inner.synthesize(input);
      },
    },
  };
}

const runtimeUrl = new URL(url.href);
runtimeUrl.username = loginName;
runtimeUrl.password = randomBytes(24).toString('hex');

function makeHttp(origin) {
  return async (path, options = {}) => {
    const res = await fetch(`${origin}/api/v1${path}`, {
      ...options,
      headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.headers ?? {}) },
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

let http;
async function login(code) {
  const res = await http('/auth/wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `login-${code}` },
    body: JSON.stringify({ code }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { token: res.body.data.access_token, id: await userIdOf(code) };
}
async function grant(token, purpose, recipients, policyVersion = 'fixture-tts-v1') {
  const res = await http('/me/consents', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `grant-${purpose}-${randomUUID().slice(0, 8)}` },
    body: JSON.stringify({ purpose, policy_version: policyVersion, recipient_ids: recipients }),
    token,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}
async function postSynthesis(token, ref, keySuffix = randomUUID().slice(0, 12)) {
  return http('/speech/synthesis', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `syn-${keySuffix}` },
    body: JSON.stringify({ checked_content_ref: ref, locale: 'zh-CN' }),
    token,
  });
}
async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
async function terminalJobState(token, jobId) {
  const res = await http(`/jobs/${jobId}`, { token });
  if (res.status !== 200) return null;
  const state = res.body.data.state;
  return ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'].includes(state) ? state : null;
}

const APPROVED_ID = 'sample-i27-approved';
const PRIVATE_ID = 'sample-i27-private';
const entries = [
  { type: 'answer', id: APPROVED_ID, revision: 1, auditState: 'approved', ownerUserId: null, text: '这段正文用于验证合成域外发账本（测试内替身文本，非真实资料）。' },
  { type: 'answer', id: PRIVATE_ID, revision: 1, auditState: 'approved', ownerUserId: '00000000-0000-4000-8000-00000000ffff', text: '他人私有正文（不得被越权朗读）。' },
];

try {
  // ---------------------------------------------------------------- 0. 前置：只允许追加在既有库上
  const version = (await owner.query('SHOW server_version')).rows[0].server_version;
  assert.match(version, /^17\.11(?:\D|$)/);
  console.log(`Native PostgreSQL: ${version} @ ${url.hostname}:${url.port}${url.pathname}`);
  const legacyRows = Number((await owner.query('SELECT count(*)::int n FROM exports')).rows[0].n);
  assert.ok(legacyRows >= 1, '本脚本必须追加在 egress-ledger-pg.mjs（EGRESS_LEDGER_KEEP=1）之后：需要既有导出行');

  // ---------------------------------------------------------------- A. 维度定义（契约外第二维度）
  assert.deepEqual([...NON_MEDIA_DATA_TYPES], ['checked_content']);
  assert.deepEqual([...NON_MEDIA_REQUIRED_CONSENTS['checked_content']], ['external_inference']);
  assert.equal(NON_MEDIA_REQUIRED_CONSENTS['checked_content'].includes('recording'), false, '新维度不得要求 recording');
  assert.equal(NON_MEDIA_REQUIRED_CONSENTS['checked_content'].includes('media_processing'), false, '新维度不得要求 media_processing');
  assert.deepEqual([...MEDIA_PURPOSE_REQUIRED_CONSENTS['voice_question']], ['recording', 'media_processing', 'external_inference']);
  say('第二维度 checked_content 只要求 external_inference（不含 recording/media_processing）；媒体维逐字未变');

  // ---------------------------------------------------------------- B. 迁移 0014：既有行可读
  const before = await owner.query(
    "SELECT count(*)::int n, count(object_id)::int u, count(object_key)::int k FROM exports",
  );
  // 本脚本会被反复重跑：`object_key` 非空的既有行数只要求**迁移前后不变**（0014 本身不得写任何键），
  // 不要求恰为 0（上一次运行若中途失败可能留下合成域行；收尾清理见 finally）。
  assert.equal(Number(before.rows[0].u), Number(before.rows[0].n), '既有行都必须有 object_id（0003 的 NOT NULL 未被放宽）');
  const keyRowsBefore = Number(before.rows[0].k);
  const legacy = (await owner.query("SELECT id, object_id FROM exports WHERE object_type='media' ORDER BY created_at ASC LIMIT 1")).rows[0];
  assert.ok(legacy !== undefined, '需要一行既有媒体导出行');
  const after = await owner.query('SELECT id, object_id, object_key FROM exports WHERE id=$1', [legacy.id]);
  assert.equal(after.rows.length, 1, '0014 之后既有行必须仍可读');
  assert.equal(String(after.rows[0].object_id), String(legacy.object_id));
  assert.equal(after.rows[0].object_key, null);
  assert.equal(Number((await owner.query('SELECT count(*)::int n FROM exports')).rows[0].n), legacyRows, '0014 不得增删既有行');
  say('迁移 0014：既有（uuid 对象标识）行逐字可读、计数不变、object_key 为 NULL（新列可空）');

  // 结构读数：列类型/可空性、XOR 约束、索引
  const col = (await owner.query(
    "SELECT data_type, is_nullable, character_maximum_length len FROM information_schema.columns WHERE table_name='exports' AND column_name='object_key'",
  )).rows[0];
  assert.equal(col.data_type, 'character varying');
  assert.equal(Number(col.len), 128);
  assert.equal(col.is_nullable, 'YES');
  const con = (await owner.query(
    "SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='public.exports'::regclass AND conname='exports_object_ident_xor'",
  )).rows[0];
  assert.match(con.def, /object_key IS NULL/);
  assert.match(con.def, /object_id = '00000000-0000-0000-0000-000000000000'::uuid/);
  assert.ok((await owner.query("SELECT 1 FROM pg_indexes WHERE tablename='exports' AND indexname='exports_object_key_idx'")).rows.length === 1);
  assert.equal(Number((await owner.query("SELECT count(*)::int n FROM pg_indexes WHERE tablename='exports' AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%object_key%'")).rows[0].n), 0, '不建唯一索引（同一份正文的第二次合法朗读不得撞唯一键）');
  say('迁移 0014 结构：object_key varchar(128) 可空 + CHECK（NULL 键 或 object_id=全零哨兵）+ 查询索引；**无**唯一索引');

  // 真库行为：约束钉死两种合法形态（③ 合法、④⑤ 被拒）
  const uA = (
    await owner.query("INSERT INTO users(wechat_subject_lookup,state,auth_epoch) VALUES(decode($1,'hex'),'active',1) RETURNING id", [subject(fx('objkey-xor'))])
  ).rows[0].id;
  const SENTINEL = '00000000-0000-0000-0000-000000000000';
  await owner.query(
    `INSERT INTO exports(user_id,object_type,object_id,object_key,object_revision,purpose,consent_epoch,recipient_id,recipient_config_version,state,auth_epoch)
     VALUES($1,'checked_content',$2::uuid,'sentinel-form-ok',1,'external_inference',1,'fixture-tts','fixture-config-v1','reserved',1)`,
    [uA, SENTINEL],
  );
  const sentinelRow = (await owner.query("SELECT object_id, object_key FROM exports WHERE user_id=$1", [uA])).rows[0];
  assert.equal(String(sentinelRow.object_id), SENTINEL);
  assert.equal(sentinelRow.object_key, 'sentinel-form-ok');
  await expectReject(
    owner.query(
      `INSERT INTO exports(user_id,object_type,object_id,object_key,object_revision,purpose,consent_epoch,recipient_id,recipient_config_version,state,auth_epoch)
       VALUES($1,'checked_content','00000000-0000-4000-8000-00000000ffff','real-uuid-plus-key',1,'external_inference',1,'fixture-tts','fixture-config-v1','reserved',1)`,
      [uA],
    ),
    '23514',
    '文本键配**真实** uuid（非哨兵）必须被 CHECK 拒绝（形态不明）',
  );
  await expectReject(
    owner.query(
      `INSERT INTO exports(user_id,object_type,object_id,object_key,object_revision,purpose,consent_epoch,recipient_id,recipient_config_version,state,auth_epoch)
       VALUES($1,'checked_content',NULL,NULL,1,'external_inference',1,'fixture-tts','fixture-config-v1','reserved',1)`,
      [uA],
    ),
    '23502',
    '两个标识都不给出必须被 object_id 的 NOT NULL 拒绝',
  );
  say('真库行为：库层只放行两种形态（媒体:真实uuid+NULL键 / 非媒体:哨兵uuid+文本键），其余组合被拒');

  // 库层长度边界：128 可写、129 被列宽拒绝（⇒ 标识**不截断**，超长写不进去，不会静默改标识）
  await owner.query(
    `INSERT INTO exports(user_id,object_type,object_id,object_key,object_revision,purpose,consent_epoch,recipient_id,recipient_config_version,state,auth_epoch)
     VALUES($1,'checked_content',$2::uuid,$3,1,'external_inference',1,'fixture-tts','fixture-config-v1','reserved',1)`,
    [uA, SENTINEL, 'k'.repeat(128)],
  );
  await expectReject(
    owner.query(
      `INSERT INTO exports(user_id,object_type,object_id,object_key,object_revision,purpose,consent_epoch,recipient_id,recipient_config_version,state,auth_epoch)
       VALUES($1,'checked_content',$2::uuid,$3,1,'external_inference',1,'fixture-tts','fixture-config-v1','reserved',1)`,
      [uA, SENTINEL, 'k'.repeat(129)],
    ),
    '22001',
    '超长（129）对象键必须被列宽拒绝（不得截断成别的标识）',
  );

  // 真库行为：最小权限角色的列级授权（可 INSERT 新列、不可 UPDATE 新列）
  //
  // **列级授权 delta（运维交付物）**：`roles/egress_ledger.sql` 已同步补 `object_key`，但**既有部署**
  // 里该角色已存在，整文件重跑会因 `CREATE ROLE` 中止事务 ⇒ 0014 上线时运维要补的就是下面这两条
  // GRANT。这里按同一形状补授并断言（漏授 ⇒ 运行时 INSERT 报 42501，被 `mapPgError` 笼统映射成
  // 503 `PROVIDER_UNAVAILABLE`，合成外发会**静默全失败**，所以必须由脚本钉住）。
  assert.match(sqlFile('roles/egress_ledger.sql'), /GRANT SELECT \([^)]*object_key[^)]*\)\s*\n?\s*ON exports TO gengyun_egress_ledger/);
  assert.match(sqlFile('roles/egress_ledger.sql'), /GRANT INSERT \([^)]*object_key[^)]*\)/);
  await owner.query('GRANT SELECT (object_key), INSERT (object_key) ON exports TO gengyun_egress_ledger');
  const granted = (
    await owner.query(
      "SELECT string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) p FROM information_schema.column_privileges WHERE grantee='gengyun_egress_ledger' AND table_name='exports' AND column_name='object_key'",
    )
  ).rows[0].p;
  assert.equal(granted, 'INSERT,SELECT', 'object_key 的列级 SELECT/INSERT 授权必须就位');
  await owner.query(`GRANT ${['gengyun_auth_privacy', 'gengyun_consent_granter', 'gengyun_egress_ledger'].join(',')} TO ${loginName}`);
  const runtimePool = createPool(runtimeUrl.href);
  await runtimePool.query(
    `INSERT INTO exports(user_id,object_type,object_id,object_key,object_revision,purpose,consent_epoch,recipient_id,recipient_config_version,state,auth_epoch)
     VALUES($1,'checked_content',$2::uuid,'runtime-insert-ok',1,'external_inference',1,'fixture-tts','fixture-config-v1','reserved',1)`,
    [uA, SENTINEL],
  );
  await expectReject(
    runtimePool.query("UPDATE exports SET object_key='tampered' WHERE user_id=$1", [uA]),
    '42501',
    '运行时角色不得改对象标识列',
  );
  await runtimePool.end();
  say('最小权限角色：可 INSERT object_key（0014 已补列级授权），**不可** UPDATE 该列（对象标识不可篡改）');
  await owner.query("DELETE FROM exports WHERE user_id=$1", [uA]);
  await owner.query('DELETE FROM users WHERE id=$1', [uA]);

  // 回滚属运维动作：psql 真跑 down 脚本（与本库既有迁移同为「运维直接执行 SQL」路径，
  // 而**迁移运行器** `npm run db:migrate` 的 up/down/重放读数在独立空库 `gengyun_w116_migrate` 上另取，
  // 因为本库的表是在运行器台账之外建的）。
  const down = 'migrations/rollback/0014_export_object_key.down.sql';
  const downOut = psqlFile(down);
  assert.match(downOut, /DROP INDEX/);
  assert.match(downOut, /COMMIT/);
  const residue = (
    await owner.query(
      `SELECT (SELECT count(*)::int FROM information_schema.columns WHERE table_name='exports' AND column_name='object_key') col,
              (SELECT count(*)::int FROM pg_constraint WHERE conname='exports_object_ident_xor') con,
              (SELECT count(*)::int FROM pg_indexes WHERE indexname='exports_object_key_idx') idx`,
    )
  ).rows[0];
  assert.deepEqual([Number(residue.col), Number(residue.con), Number(residue.idx)], [0, 0, 0]);
  assert.equal(Number((await owner.query('SELECT count(*)::int n FROM exports')).rows[0].n), legacyRows, '回滚不得增删既有行');
  const stillReadable = await owner.query('SELECT id, object_id FROM exports WHERE id=$1', [legacy.id]);
  assert.equal(stillReadable.rows.length, 1, '回滚后既有行必须仍可读');
  say('0014 回滚（psql 真跑，exit 0）：列/约束/索引如实消失，既有行仍可读、计数不变');

  const upOut = psqlFile('migrations/0014_export_object_key.sql');
  assert.match(upOut, /CREATE INDEX/);
  assert.match(upOut, /COMMIT/);
  const replayed = (
    await owner.query(
      `SELECT (SELECT count(*)::int FROM information_schema.columns WHERE table_name='exports' AND column_name='object_key') col,
              (SELECT count(*)::int FROM pg_constraint WHERE conname='exports_object_ident_xor') con,
              (SELECT count(*)::int FROM pg_indexes WHERE indexname='exports_object_key_idx') idx`,
    )
  ).rows[0];
  assert.deepEqual([Number(replayed.col), Number(replayed.con), Number(replayed.idx)], [1, 1, 1]);
  const defAfterReplay = (await owner.query("SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname='exports_object_ident_xor'")).rows[0].def;
  assert.match(defAfterReplay, /object_key IS NULL/);
  assert.match(defAfterReplay, /object_id = '00000000-0000-0000-0000-000000000000'::uuid/);
  assert.equal(Number((await owner.query('SELECT count(*)::int n FROM exports')).rows[0].n), legacyRows, '重放不得增删既有行');
  assert.equal(
    Number((await owner.query('SELECT count(object_key)::int k FROM exports')).rows[0].k),
    keyRowsBefore,
    '0014 的上/下/重放都不得改动既有键行数（迁移不写业务数据）',
  );
  say('0014 重放（psql 真跑，exit 0）：列/约束/索引复现且约束定义逐字一致，既有行仍可读');

  // 真库发现（**运维必须先知道**）：`DROP COLUMN` 会**连带撤销该列的列级授权**（ACL 项随列消失），
  // 因此「回滚过 0014」的库在重放后必须**重新**执行 0014 头注释里的 GRANT，否则运行时的
  // 墓碑查询/登记 INSERT 会以 `permission denied` 失败（被 `mapPgError` 笼统映射成 503）。
  const aclAfterReplay = (
    await owner.query(
      `SELECT has_column_privilege('gengyun_egress_ledger','public.exports','object_key','SELECT') sel,
              has_column_privilege('gengyun_egress_ledger','public.exports','object_key','INSERT') ins`,
    )
  ).rows[0];
  assert.deepEqual([aclAfterReplay.sel, aclAfterReplay.ins], [false, false], '重放后列级授权应为「已被回滚撤销」的状态（钉住这条真库行为）');
  await owner.query('GRANT SELECT (object_key), INSERT (object_key) ON exports TO gengyun_egress_ledger');
  const aclRegranted = (
    await owner.query(
      `SELECT has_column_privilege('gengyun_egress_ledger','public.exports','object_key','SELECT') sel,
              has_column_privilege('gengyun_egress_ledger','public.exports','object_key','INSERT') ins`,
    )
  ).rows[0];
  assert.deepEqual([aclRegranted.sel, aclRegranted.ins], [true, true], '按运维动作补授后必须就位');
  say('0014 重放后列级授权被回滚连带撤销 ⇒ 按运维动作重新 GRANT 后授权就位（漏授会静默降级为 503）');

  // ---------------------------------------------------------------- D. 政策/接收方 + 装配
  const bindings = {
    'fixture-tts': {
      config_version: 'fixture-config-v1',
      policy_version: 'fixture-recipient-v1',
      capability: 'tts',
      retention_online_days: 0,
      retention_backup_days: 0,
      no_training_evidence_ref: 'fixture://proof/no-training',
      deletion_evidence_ref: 'fixture://proof/deletion',
    },
  };
  // 政策：前序脚本已插 (external_inference,'fixture-v1')（绑定 fixture-weed）。已复审政策的
  // `recipient_bindings` 受**不可变触发器**保护（真库实测：UPDATE 报 `reviewed policy content is immutable`）
  // ⇒ 引入新接收方的正当路径是**新增一个政策版本**，本脚本照做（policy_version='fixture-tts-v1'）。
  const reviewer = (
    await owner.query(
      "INSERT INTO admin_accounts(login_name,credential_hash) VALUES('fixture-i27-reviewer','synthetic-unused') ON CONFLICT (login_name) DO UPDATE SET credential_hash=EXCLUDED.credential_hash RETURNING id",
    )
  ).rows[0].id;
  // 真库另有 `consent_policies_enabled_purpose`（每个用途**只允许一个 enabled 政策**）⇒ 换版的正当动作是
  // 「停用旧版 + 启用新版」（实测：`enabled` 不在不可变触发器保护范围内，可切换；content 才不可改）。
  await owner.query("UPDATE consent_policies SET enabled=false WHERE purpose='external_inference' AND policy_version<>'fixture-tts-v1'");
  await owner.query(
    `INSERT INTO consent_policies(purpose,policy_version,source_kind,source_ref,content_sha256,review_evidence_ref,recipient_bindings,valid_from,valid_until,reviewed_by,reviewed_at,enabled)
     VALUES('external_inference','fixture-tts-v1','synthetic','fixture://policy/terms',$1,'fixture://policy/review',$2::jsonb,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour',$3,clock_timestamp(),true)
     ON CONFLICT (purpose,policy_version) DO NOTHING`,
    ['b'.repeat(64), JSON.stringify(bindings), reviewer],
  );
  const enabledForPurpose = (
    await owner.query("SELECT policy_version FROM consent_policies WHERE purpose='external_inference' AND enabled ORDER BY policy_version")
  ).rows.map((row) => row.policy_version);
  assert.deepEqual(enabledForPurpose, ['fixture-tts-v1'], '每个用途恰一个 enabled 政策；旧版已复审内容逐字未改，仅切换启用位');
  await owner.query(
    `INSERT INTO recipients(id,display_name,capability,policy_version,retention_online_days,retention_backup_days,no_training_verified,deletion_verified,enabled,config_version)
     VALUES('fixture-tts','合成 TTS 接收方（测试）','tts','fixture-recipient-v1',0,0,true,true,true,'fixture-config-v1')
     ON CONFLICT (id) DO NOTHING`,
  );
  say('合成用途政策 + 已验证 TTS 接收方（fixture-tts, capability=tts, 禁止训练/可删除）就绪');

  const realConfig = { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'real', sessionSigningKey: key };
  const wechat = { exchange: async (code) => ({ subjectLookupHex: subject(code) }) };
  const transport = syntheticTtsTransport();
  const contentPort = createMemoryCheckedContentPort(entries);
  pool = createPool(runtimeUrl.href);
  app = buildApp({
    config: realConfig,
    pool,
    wechat,
    synthesisProvider: transport.provider,
    synthesisContent: contentPort,
    // 产物存储用**替身**：本脚本测的是外发账本，不测对象存储（真实存储未接线 ⇒ 生产 real 一律失败关闭）。
    synthesisMedia: createSubstituteMediaPort(),
    consentGrantTestOptions: { allowSyntheticGrantPolicy: true },
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  http = makeHttp(origin);
  say('buildApp(real + 真 PG 池 + 注入的合成 real 传输/替身产物存储) 启动');

  // ---------------------------------------------------------------- E. 正控制：授权齐备 ⇒ 预留 + markSent + 出站
  const p = await login(fx('i27-syn-positive'));
  await grant(p.token, 'external_inference', ['fixture-tts']);
  const created = await postSynthesis(p.token, { type: 'answer', id: APPROVED_ID, revision: 1 });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const jobId = created.body.data.id;
  const state = await waitFor(() => terminalJobState(p.token, jobId), '正控制任务终态');
  assert.equal(state, 'succeeded');
  const row = await exportRowFor(p.id);
  assert.ok(row !== null, '必须落账');
  assert.equal(row.object_type, 'checked_content');
  assert.equal(row.object_key, `answer:${APPROVED_ID}`, '账本登记的对象键必须由执行期重读的已核对正文快照 (type,id) 派生');
  assert.equal(String(row.object_id), '00000000-0000-0000-0000-000000000000', '文本型对象用全零哨兵占位（uuid 列 NOT NULL 未放宽）');
  assert.equal(row.object_revision, 1);
  assert.equal(row.state, 'sent');
  assert.equal(row.purpose, 'external_inference');
  assert.equal(row.recipient_id, 'fixture-tts');
  assert.equal(row.job_id, jobId);
  assert.equal(Number(row.auth_epoch), 1);
  assert.deepEqual(Object.keys(row.required_consents).sort(), ['external_inference'], '必需用途只含 external_inference（不多要 recording/media_processing）');
  assert.equal(Number((await owner.query('SELECT count(*)::int n FROM exports WHERE user_id=$1', [p.id])).rows[0].n), 1, '一次合法外发恰一行');
  assert.equal(transport.calls.length, 1, '载荷必须出站一次（测试内替身传输）');
  assert.equal(transport.calls[0].targetRef.id, APPROVED_ID);
  assert.equal(transport.calls[0].targetRef.revision, 1);
  const written = await writebackFor(row.id);
  assert.ok(written !== null, '成功派发必须写回（与校验同事务）');
  assert.equal(written.result.content_class, 'structural_only');
  assert.equal(JSON.stringify(written.result).includes('这段正文'), false, '回写不得落提供者载荷/正文');
  assert.equal(JSON.stringify(written.result).includes('替身占位产物'), false, '回写不得落产物字节');
  say('正控制（真 PG）：real 合成域 reserve → assertExecutable → markSent → 传输 → saveResult；账本登记 object_key=<正文类型>:<快照 id>、哨兵 object_id、仅 external_inference');

  // ---------------------------------------------------------------- F. 负控制 ①：无预留就出站
  const registration = await import('../../services/api/src/privacy/synthesis-egress.ts');
  const { createPostgresExportLedger, createPostgresPrivacyPorts } = await import('../../services/api/src/privacy/ledger-pg.ts');
  const { createInFlightGuard } = await import('../../packages/privacy/in-flight.mjs');
  const q = await login(fx('i27-syn-unregistered'));
  await grant(q.token, 'external_inference', ['fixture-tts']);
  const rawEgress = registration.createSynthesisEgress({
    ledger: createPostgresExportLedger({ pool }),
    inFlight: createInFlightGuard({
      ledger: createPostgresExportLedger({ pool }),
      account: createPostgresPrivacyPorts({ pool }).account,
      consentStore: createPostgresPrivacyPorts({ pool }).consentStore,
    }),
    executionMode: 'real',
    content: contentPort,
    capability: 'tts',
  });
  const rawProvider = rawEgress.provider({
    available: true,
    unavailableReason: null,
    async synthesize() {
      throw new Error('不应到达真实传输：无预留必须被拒');
    },
  });
  await expectReject(
    rawProvider.synthesize({ jobId: randomUUID(), text: 'x', locale: 'zh-CN', targetRef: { type: 'answer', id: APPROVED_ID, revision: 1 } }),
    'OBJECT_UNAVAILABLE',
    '无预留就出站必须被拒',
  );
  assert.equal(await exportRowsFor(q.id).then((rows) => rows.length), 0, '被拒的外发不得留下任何账本行');
  say('负控制 ①（真 PG）：未登记的派发 ⇒ OBJECT_UNAVAILABLE「无外发预留」，且零账本行');

  // ---------------------------------------------------------------- G. 负控制 ②：用途未授权
  const r = await login(fx('i27-syn-noconsent'));
  // 负控制 ②：只授 `media_processing`（**媒体维**用途）⇒ 不得代替合成域的 `external_inference`。
  // 该用途的启用政策版本是基线脚本建的 `fixture-v1`，其 `recipient_bindings` 只含基线接收方
  // `fixture-weed`（绑定别的接收方会被「接收方核验证据不可用」403 挡在授权之前）。
  await grant(r.token, 'media_processing', ['fixture-weed'], 'fixture-v1');
  const deniedConsent = await postSynthesis(r.token, { type: 'answer', id: APPROVED_ID, revision: 1 });
  assert.equal(deniedConsent.status, 403, JSON.stringify(deniedConsent.body));
  assert.equal(deniedConsent.body.error.code, 'CONSENT_REQUIRED');
  assert.equal((await exportRowsFor(r.id)).length, 0, '被拒的受理不得留下账本行');
  say('负控制 ②（真 PG）：只授 media_processing ⇒ 403 CONSENT_REQUIRED（不做任何账本变更）');

  // ---------------------------------------------------------------- H. 负控制 ③：对象标识非法 / 未登记
  const s = await login(fx('i27-syn-badkey'));
  await grant(s.token, 'external_inference', ['fixture-tts']);
  const approvedKey = `answer:${APPROVED_ID}`;
  for (const bad of ['', 'k'.repeat(81), 'has space', 'UPPER_not_allowed', 'k'.repeat(80)]) {
    const res = await postSynthesis(s.token, { type: 'answer', id: bad, revision: 1 });
    assert.ok([400, 403, 404, 409].includes(res.status), `非法/未登记对象标识必须被拒：${bad.slice(0, 12)} ⇒ ${res.status} ${JSON.stringify(res.body)}`);
    assert.notEqual(res.status, 202, '非法/未登记对象标识不得被受理');
  }
  assert.equal((await exportRowsFor(s.id)).length, 0, '非法标识不得留下账本行');
  const scoped = rawEgress.withOwner(s.id);
  await expectReject(
    scoped.reserveForAcceptance({ userId: s.id, authEpoch: 1, contentType: 'answer', contentId: 'not-registered-entry', contentRevision: 1 }),
    'OBJECT_UNAVAILABLE',
    '未登记的已核对正文标识不得预留',
  );
  // 标识形式合法但**已核对正文不可见**（端口无此条目）⇒ 预留阶段即拒，零账本行。
  assert.equal((await exportRowsFor(s.id)).length, 0);
  say('负控制 ③（真 PG）：空 / 超 80（schema 拒）/ 含空格 / 大写 / 未登记的正文标识全部被拒，零账本行');

  // ---------------------------------------------------------------- I. 越权与幂等重放
  const t = await login(fx('i27-syn-foreign'));
  await grant(t.token, 'external_inference', ['fixture-tts']);
  const foreign = await postSynthesis(t.token, { type: 'answer', id: PRIVATE_ID, revision: 1 });
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  // 越权目标：**受理期预留先于服务层判定**（与识别域的既有形状一致）⇒ 服务层 404 后路由把预留
  // 释放为终态。留下的是**一条结构审计行**（failed / ACCEPTANCE_FAILED），不含任何载荷、无回写、
  // 绝不派发、绝不残留 reserved。
  const foreignRows = await exportRowsFor(t.id);
  assert.equal(foreignRows.length, 1, '越权受理失败：预留必须被释放为终态（不得残留 reserved）');
  assert.equal(foreignRows[0].state, 'failed');
  assert.equal(foreignRows[0].error_code, 'ACCEPTANCE_FAILED');
  assert.equal(foreignRows[0].object_key, `answer:${PRIVATE_ID}`, '审计行只记结构标识（正文键），不含载荷');
  assert.equal(await writebackCount(foreignRows[0].id), 0, '被拒的受理零回写');
  const u = await login(fx('i27-syn-replay'));
  await grant(u.token, 'external_inference', ['fixture-tts']);
  const first = await postSynthesis(u.token, { type: 'answer', id: APPROVED_ID, revision: 1 }, 'replay-key-0001');
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await waitFor(() => terminalJobState(u.token, first.body.data.id), '重放用例首任务终态');
  const replay = await postSynthesis(u.token, { type: 'answer', id: APPROVED_ID, revision: 1 }, 'replay-key-0001');
  assert.equal(replay.status, 202, JSON.stringify(replay.body));
  assert.equal(replay.body.data.id, first.body.data.id, '同键同体重放必须回放同一任务');
  const rowsU = await exportRowsFor(u.id);
  assert.equal(rowsU.length, 2, '两次受理各一行；重放那次必须被置终态（不残留 reserved）');
  assert.deepEqual(rowsU.map((row) => row.state).sort(), ['failed', 'sent'], '重放不得留下永不派发的 reserved 行');
  assert.equal(rowsU.find((row) => row.state === 'failed').error_code, 'ACCEPTANCE_FAILED');
  assert.equal(rowsU.find((row) => row.state === 'sent').object_key, approvedKey);
  say('幂等重放（真 PG）：同键同体重放回放同一任务，且为那次不会派发的受理补写终态（无残留 reserved）');
  say('越权目标 404：受理期预留被释放为 failed/ACCEPTANCE_FAILED 结构审计行（无载荷、零回写、零派发）');

  // ---------------------------------------------------------------- J. 默认仍失败关闭
  const fallbackApp = buildApp({
    config: realConfig,
    pool,
    wechat,
    // 不注入合成提供者 ⇒ `createTtsProvider({executionMode:'real'})` = 缺凭据 fail-closed
    synthesisContent: contentPort,
    synthesisMedia: createSubstituteMediaPort(),
    consentGrantTestOptions: { allowSyntheticGrantPolicy: true },
  });
  const fallbackOrigin = await fallbackApp.listen({ host: '127.0.0.1', port: 0 });
  const fallbackHttp = makeHttp(fallbackOrigin);
  http = fallbackHttp;
  const v = await login(fx('i27-syn-realmode'));
  await fallbackHttp('/me/consents', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `grant-external_inference-${randomUUID().slice(0, 8)}` },
    body: JSON.stringify({ purpose: 'external_inference', policy_version: 'fixture-tts-v1', recipient_ids: ['fixture-tts'] }),
    token: v.token,
  });
  const denied = await fallbackHttp('/speech/synthesis', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `syn-real-${randomUUID().slice(0, 12)}` },
    body: JSON.stringify({ checked_content_ref: { type: 'answer', id: APPROVED_ID, revision: 1 }, locale: 'zh-CN' }),
    token: v.token,
  });
  assert.equal(denied.status, 503, JSON.stringify(denied.body));
  assert.equal(denied.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(denied.body.error.retryable, true);
  assert.equal((await exportRowsFor(v.id)).length, 0, 'real 未接真实传输：不得产生任何账本行（零 sent）');
  await fallbackApp.close();
  http = makeHttp(origin);
  say('默认仍失败关闭：real 未接真实传输 ⇒ 503 PROVIDER_UNAVAILABLE(retryable)，该用户零账本行（任何账本变更之前拒绝）');

  console.log(`\nRESULT=PASS ${passed} 组；真实 PostgreSQL ${version}（本机隔离、仅回环）；未发出任何对外/付费请求；未使用真实 TTS 供应商`);
} finally {
  await app?.close?.();
  await pool?.end?.();
  await owner.query("DELETE FROM export_writebacks WHERE export_id IN (SELECT id FROM exports WHERE object_type='checked_content')").catch(() => {});
  await owner.query("DELETE FROM exports WHERE object_type='checked_content'").catch(() => {});
  await owner.query("DELETE FROM users WHERE wechat_subject_lookup=decode($1,'hex')", [subject(fx('objkey-xor'))]).catch(() => {});
  await owner.end();
  console.log('CLEANUP=done（合成域账本行已清理；库/角色由前序脚本与运行器负责）');
}
