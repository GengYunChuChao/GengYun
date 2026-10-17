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

/** 以**运维连接**（owner）执行一段 SQL 文本，返回 psql 的原始输出（用于前置/收尾的库状态复位）。 */
function psqlSql(sql) {
  const args = ['-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username), '-d', 'gengyun_egress_test', '-v', 'ON_ERROR_STOP=1', '-tA', '-c', sql];
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

// 库状态读数（前置复位与收尾都用它，避免口径漂移）：object_key 列 / 0014 的 XOR / 0015 的形状约束。
const DB_STATE_SQL = `SELECT (SELECT count(*)::int FROM information_schema.columns WHERE table_name='exports' AND column_name='object_key') col,
       (SELECT count(*)::int FROM pg_constraint WHERE conname='exports_object_ident_xor') xor,
       (SELECT count(*)::int FROM pg_constraint WHERE conname='exports_object_key_shape') shape`;

/**
 * 本脚本**会被反复重跑**（与 egress-ledger-pg.mjs 同一套 EGRESS_LEDGER_KEEP 约定）。
 * 它自己会走 0015 上/下/重放，因此收尾与前置必须把库复位到**确定起点**：0014 已应用、0015 未应用。
 * 不这么做的话，第二次运行会在「0014 放行缺陷形态」那一步因为 0015 已经生效而红 —— 那是脚本状态泄漏，
 * 不是被测行为回归。
 */
function restore0014Only() {
  const state = JSON.parse(psqlSql(`SELECT row_to_json(s) FROM (${DB_STATE_SQL}) s`));
  if (Number(state.shape) > 0) psqlFile('migrations/rollback/0015_export_object_key_shape.down.sql');
  if (Number(state.col) === 0) psqlFile('migrations/0014_export_object_key.sql');
  return state;
}

const restoredFrom = restore0014Only();
console.log(`库状态复位：起点 col=${restoredFrom.col} xor=${restoredFrom.xor} shape=${restoredFrom.shape} ⇒ 0014-only`);

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
  // P2-a 的**缺陷形态读数**：在 0014 生效期间，「哨兵 object_id + NULL 键」= 两个标识都没有，却被放行。
  // 这一行是故意写进去的，用来证明「0014 的声明与实际库层语义不一致」不是推测；随后同一形状的 INSERT
  // 必须在收紧后（0015）被拒 —— 负控制 ④ 与它成对。
  const orphanUnder0014 = await owner.query(
    `INSERT INTO exports(user_id,object_type,object_id,object_key,object_revision,purpose,consent_epoch,recipient_id,recipient_config_version,state,auth_epoch)
     VALUES($1,'checked_content',$2::uuid,NULL,1,'external_inference',1,'fixture-tts','fixture-config-v1','reserved',1)
     RETURNING id`,
    [uA, SENTINEL],
  );
  assert.equal(
    Number((await owner.query('SELECT count(*)::int n FROM exports WHERE id=$1', [orphanUnder0014.rows[0].id])).rows[0].n),
    1,
    '0014 正文（单向 OR）确实放行「哨兵 + NULL 键」——这是被 0015 收紧的缺陷形态',
  );
  say('真库行为（0014）：库层放行两种形态 + **缺陷形态**（哨兵 object_id 配 NULL 键 = 无标识）——0015 收紧');

  // P2-a：把 0015 真正应用到库上（而不是只断言迁移文件的文本），再让同一批 INSERT 读数证明收紧已生效。
  //
  // **真库发现（上线必须先知道）**：0015 的 XOR 是**普通**（非 NOT VALID）约束 ⇒ 库里只要存在一条
  // 「哨兵 + NULL 键」的历史行，`ALTER TABLE ... ADD CONSTRAINT` 就会**失败**（实测：
  // `check constraint "exports_object_ident_xor" of relation "exports" is violated by some row`），
  // 整条迁移回滚。这是刻意的前向收紧：升级前必须先把这类无标识行查出来人工处置。
  // 本脚本先把刚写入的缺陷行**读全**（留证），再按运维动作删掉它，然后才应用 0015。
  const orphanShape = (await owner.query(
    'SELECT id, user_id, object_type, object_id, object_key, state FROM exports WHERE id=$1',
    [orphanUnder0014.rows[0].id],
  )).rows[0];
  assert.equal(String(orphanShape.object_id), SENTINEL);
  assert.equal(orphanShape.object_key, null);
  const applyFailsWithOrphan = (() => {
    try {
      psqlFile('migrations/0015_export_object_key_shape.sql');
      return null;
    } catch (error) {
      return String(error.stderr ?? error.message);
    }
  })();
  assert.match(
    String(applyFailsWithOrphan),
    /exports_object_ident_xor.*is violated by some row/,
    '存在无标识历史行时 0015 必须如实失败（不得静默放行，也不得自动删数据）',
  );
  assert.equal(
    Number((await owner.query("SELECT count(*)::int n FROM pg_constraint WHERE conname='exports_object_key_shape'")).rows[0].n),
    0,
    '失败的 0015 不得留下半截约束（整条迁移在一个事务里回滚）',
  );
  say('P2-a 上线前置条件（真库实测）：存在「哨兵 + NULL 键」历史行 ⇒ 0015 的 ADD CONSTRAINT 如实失败并整体回滚');
  await owner.query('DELETE FROM exports WHERE id=$1', [orphanUnder0014.rows[0].id]);
  const shapeUpOut = psqlFile('migrations/0015_export_object_key_shape.sql');
  // `-tA` 下 psql 只回**命令标签**（不回正文）：0015 恰三条 ALTER TABLE（撤旧 XOR、建新 XOR、建形状 CHECK）+ 一条 COMMENT。
  assert.match(shapeUpOut, /^BEGIN\r?\nALTER TABLE/);
  assert.equal((shapeUpOut.match(/ALTER TABLE/g) ?? []).length, 3, '0015 必须是「撤 XOR + 建 XOR + 建形状 CHECK」三条 ALTER');
  assert.match(shapeUpOut, /COMMENT/);
  assert.match(shapeUpOut, /COMMIT/);
  const xorAfterUp = (await owner.query(
    "SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='public.exports'::regclass AND conname='exports_object_ident_xor'",
  )).rows[0].def;
  assert.match(xorAfterUp, /object_key IS NOT NULL/, '0015 之后 XOR 必须是双向口径（键非空 ⟺ 哨兵）');
  const shapeDef = (await owner.query(
    "SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='public.exports'::regclass AND conname='exports_object_key_shape'",
  )).rows[0].def;
  assert.match(shapeDef, /\^\[a-z0-9\._:-\]\{1,128\}\$/);
  assert.equal(
    Number((await owner.query('SELECT count(*)::int n FROM exports WHERE id=$1', [orphanUnder0014.rows[0].id])).rows[0].n),
    0,
    '0015 只加约束、不改数据：那条无标识历史行是**运维**删掉的（迁移自己绝不删业务行）',
  );
  say('迁移 0015（真库应用）：XOR 收紧为双向 + 新增对象键形状 CHECK；既有行不动');

  // 收紧后的负控制（与上面那行「缺陷形态」成对读数）
  await expectReject(
    owner.query(
      `INSERT INTO exports(user_id,object_type,object_id,object_key,object_revision,purpose,consent_epoch,recipient_id,recipient_config_version,state,auth_epoch)
       VALUES($1,'checked_content',$2::uuid,NULL,1,'external_inference',1,'fixture-tts','fixture-config-v1','reserved',1)`,
      [uA, SENTINEL],
    ),
    '23514',
    '哨兵 object_id 配 NULL 键（两个标识都没有）必须被收紧后的 XOR 拒绝',
  );
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
  say('真库行为（0015 之后）：库层只放行两种形态（媒体:真实uuid+NULL键 / 非媒体:哨兵uuid+文本键），其余组合被拒');

  // P2-a：对象键**形状**（不只是长度）。列宽 varchar(128) 挡不住空串 / 大写 / 空格 / 控制字符，
  // 这些值一旦入库就不是可靠的对象标识；0015 的 `exports_object_key_shape` 在库层挡下它们，
  // 与运行时 `synthesis-egress.ts` 的 `OBJECT_KEY` 校验同口径。
  for (const [badKey, label] of [
    ['', '空串'],
    ['has space', '含空格'],
    ['UPPER_not_allowed', '含大写'],
    ['trailing\nnewline', '含控制字符'],
  ]) {
    await expectReject(
      owner.query(
        `INSERT INTO exports(user_id,object_type,object_id,object_key,object_revision,purpose,consent_epoch,recipient_id,recipient_config_version,state,auth_epoch)
         VALUES($1,'checked_content',$2::uuid,$3,1,'external_inference',1,'fixture-tts','fixture-config-v1','reserved',1)`,
        [uA, SENTINEL, badKey],
      ),
      '23514',
      `对象键形状非法必须被 CHECK 拒绝（${label}）`,
    );
  }
  await owner.query(
    `INSERT INTO exports(user_id,object_type,object_id,object_key,object_revision,purpose,consent_epoch,recipient_id,recipient_config_version,state,auth_epoch)
     VALUES($1,'checked_content',$2::uuid,'a-z0-9._:-ok',1,'external_inference',1,'fixture-tts','fixture-config-v1','reserved',1)`,
    [uA, SENTINEL],
  );
  say('真库行为：对象键形状（1..128 小写字母/数字/_-.:）由 CHECK 在库层钉死，空串/空格/大写/控制字符写不进去');

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
  // GRANT。
  //
  // GY-I27 P2-c：这里**不再「自授权限后自证」**。旧版脚本自己 GRANT 再自己断言就位，于是
  // 「漏授 ⇒ 运行时 INSERT 报 42501 ⇒ 被 `mapPgError` 笼统映射成 503 `PROVIDER_UNAVAILABLE` ⇒
  // 合成外发静默全失败」这条结论**从未被真库证明**（脚本把要证的前提自己补上了）。现在的口径是：
  //   (1) 断言 `roles/egress_ledger.sql` 文本里确有这两条列级 GRANT（交付物形态）；
  //   (2) 断言**当下库里**确实就位（前置脚本/运维动作的读数，不是本脚本刚写的）；
  //   (3) **REVOKE** 掉列级 SELECT/INSERT ⇒ 同一路径必须如实失败（DB 层 42501 + HTTP 503，零账本行）；
  //   (4) **GRANT 复原** ⇒ 同一路径必须重新成功（证明失败确由漏授引起，且复原是真的复原）。
  // 第 (3)(4) 步是本片新增的**真实故障注入**，HTTP 那半在 `p` 用户登录后执行（见 E 段末尾）。
  assert.match(sqlFile('roles/egress_ledger.sql'), /GRANT SELECT \([^)]*object_key[^)]*\)\s*\n?\s*ON exports TO gengyun_egress_ledger/);
  assert.match(sqlFile('roles/egress_ledger.sql'), /GRANT INSERT \([^)]*object_key[^)]*\)/);
  const ledgerAcl = async () => {
    const row = (
      await owner.query(
        `SELECT has_column_privilege('gengyun_egress_ledger','public.exports','object_key','SELECT') sel,
                has_column_privilege('gengyun_egress_ledger','public.exports','object_key','INSERT') ins`,
      )
    ).rows[0];
    return [row.sel, row.ins];
  };
  assert.deepEqual(await ledgerAcl(), [true, true], 'object_key 的列级 SELECT/INSERT 必须**已经**就位（不得由本脚本自授后自证）');
  const tableLevel = (
    await owner.query(
      "SELECT string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) p FROM information_schema.table_privileges WHERE grantee='gengyun_egress_ledger' AND table_name='exports'",
    )
  ).rows[0].p;
  assert.equal(tableLevel, null, '该角色在 exports 上**没有**表级授权（全列级）⇒ 撤掉 object_key 的列级授权必须真的挡住 INSERT');
  await owner.query(`GRANT ${['gengyun_auth_privacy', 'gengyun_consent_granter', 'gengyun_egress_ledger'].join(',')} TO ${loginName}`);
  // runtimeUrl 的密码是本脚本自己 randomBytes 出来的，与前置账本脚本给角色写下的那个不是同一个：
  // trust 认证下看不出差别，但 CI 的 PostgreSQL 17 默认 scram-sha-256 ⇒ 不把这个密码落到角色上，下一句首连就 28P01。
  await owner.query(`ALTER ROLE ${loginName} PASSWORD '${runtimeUrl.password}'`);
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
  say('最小权限角色（授权就位时）：可 INSERT object_key，**不可** UPDATE 该列（对象标识不可篡改）');

  // P2-c 故障注入（DB 层）：撤掉列级授权 ⇒ 同一 INSERT 必须 42501（这正是漏授时的运行时形态）。
  await owner.query('REVOKE SELECT (object_key), INSERT (object_key) ON exports FROM gengyun_egress_ledger');
  assert.deepEqual(await ledgerAcl(), [false, false], 'REVOKE 必须真的撤掉列级授权');
  const revokedPool = createPool(runtimeUrl.href);
  await expectReject(
    revokedPool.query(
      `INSERT INTO exports(user_id,object_type,object_id,object_key,object_revision,purpose,consent_epoch,recipient_id,recipient_config_version,state,auth_epoch)
       VALUES($1,'checked_content',$2::uuid,'revoked-insert',1,'external_inference',1,'fixture-tts','fixture-config-v1','reserved',1)`,
      [uA, SENTINEL],
    ),
    '42501',
    '漏授列级 INSERT ⇒ 运行时账本登记必须 permission denied（不是静默跳过）',
  );
  await revokedPool.end();
  await owner.query("DELETE FROM exports WHERE user_id=$1", [uA]);
  await owner.query('DELETE FROM users WHERE id=$1', [uA]);
  say('P2-c 故障注入①（真 PG）：撤掉 object_key 列级授权 ⇒ 运行时账本 INSERT 42501（漏授不是「降级」，是拒绝）');

  // 回滚属运维动作：psql 真跑 down 脚本（与本库既有迁移同为「运维直接执行 SQL」路径，
  // 而**迁移运行器** `npm run db:migrate` 的 up/down/重放读数在独立空库 `gengyun_w116_migrate` 上另取，
  // 因为本库的表是在运行器台账之外建的）。
  //
  // 顺序即真实运维顺序：**先**回滚 0015（它是 0014 之上的收紧），再回滚 0014；否则 0014 的 down 会与
  // 0015 留下的形状约束互相纠缠（0014 down 只 DROP 它自己那条 XOR）。
  const down15 = 'migrations/rollback/0015_export_object_key_shape.down.sql';
  const down15Out = psqlFile(down15);
  // `-tA` 只回命令标签：0015 的 down 是「撤形状 CHECK + 撤收紧后的 XOR + 还原 0014 的单向 XOR」三条 ALTER。
  assert.match(down15Out, /^BEGIN\r?\nALTER TABLE/);
  assert.equal((down15Out.match(/ALTER TABLE/g) ?? []).length, 3, '0015 down 必须是三条 ALTER（另有还原 COMMENT 一条）');
  assert.match(down15Out, /COMMIT/);
  const afterDown15 = (
    await owner.query(
      `SELECT (SELECT count(*)::int FROM pg_constraint WHERE conname='exports_object_key_shape') shape,
              (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='exports_object_ident_xor') xor`,
    )
  ).rows[0];
  assert.equal(Number(afterDown15.shape), 0, '0015 回滚必须撤掉形状约束');
  assert.doesNotMatch(afterDown15.xor, /object_key IS NOT NULL/, '0015 回滚必须把 XOR 还原成 0014 的单向正文');
  assert.match(afterDown15.xor, /object_key IS NULL/);
  say('0015 回滚（psql 真跑，exit 0）：形状约束消失、XOR 还原为 0014 的单向口径（回滚是 0014 的前置）');

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
  // 重放 0014 得到的是它**历史正文**的单向口径（0015 的收紧是独立版本，不会被 0014 带回）；
  // 随后重放 0015 恢复收紧后的库层语义。两个版本各自的真实形态都被真库读数钉住。
  assert.doesNotMatch(defAfterReplay, /object_key IS NOT NULL/, '0014 正文是单向 OR');
  assert.match(defAfterReplay, /object_key IS NULL/);
  assert.match(defAfterReplay, /object_id = '00000000-0000-0000-0000-000000000000'::uuid/);
  assert.equal(
    Number((await owner.query("SELECT count(*)::int n FROM pg_constraint WHERE conname='exports_object_key_shape'")).rows[0].n),
    0,
    '重放 0014 不得带回 0015 的形状约束（两者是独立版本，回滚/重放互不牵连）',
  );
  // 再重放 0015（这里必须走 psql 真跑，而不是复用上面的字符串常量）：
  // 0014 down/up 之间 object_key 被 DROP 过，0015 的 down 已撤掉形状约束 ⇒ 重放 0015 必须能重新建立它。
  const shapeUpReplayOut = psqlFile('migrations/0015_export_object_key_shape.sql');
  // 同前：`-tA` 只回命令标签 ⇒ 用标签计数钉住「撤 XOR + 建 XOR + 建形状 CHECK」三条 ALTER。
  assert.match(shapeUpReplayOut, /^BEGIN\r?\nALTER TABLE/);
  assert.equal((shapeUpReplayOut.match(/ALTER TABLE/g) ?? []).length, 3, '重放 0015 同样是三条 ALTER');
  assert.match(shapeUpReplayOut, /COMMIT/);
  const xorAfterReplay = (await owner.query("SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname='exports_object_ident_xor'")).rows[0].def;
  assert.match(xorAfterReplay, /object_key IS NOT NULL/, '重放 0015 之后 XOR 必须是收紧后的双向口径');
  const shapeAfterReplay = (await owner.query("SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname='exports_object_key_shape'")).rows[0].def;
  assert.match(shapeAfterReplay, /\^\[a-z0-9\._:-\]\{1,128\}\$/);
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

  // P2-c 故障注入②（HTTP 端到端，**这就是「漏授 ⇒ 静默全失败」那条结论的真库证据**）：
  // 授权必须处于 REVOKE 状态 ⇒ 同一用户的**新**一次合成受理必须在任何账本变更之前 503
  // `PROVIDER_UNAVAILABLE`(retryable)，且**零新增账本行、零出站**。随后 GRANT 复原 ⇒ 同一路径必须成功。
  //
  // 注意：`0014` 重放段（上方 :586）已按**运维动作**把列级授权补回来（`DROP COLUMN` 连带撤销过它），
  // 所以这里必须**重新**注入撤权——否则本段测的是「授权就位」，只会拿到 202（实测红点即此）。
  // 口径不变：REVOKE 是**故障注入**、GRANT 是**运维复原**，脚本在任何断言之前都不自我授权。
  await owner.query('REVOKE SELECT (object_key), INSERT (object_key) ON exports FROM gengyun_egress_ledger');
  assert.deepEqual(await ledgerAcl(), [false, false], '注入②之前必须确已撤权（否则本段退化成正控制）');
  const sentBeforeRevoked = Number((await owner.query('SELECT count(*)::int n FROM exports WHERE user_id=$1', [p.id])).rows[0].n);
  const callsBeforeRevoked = transport.calls.length;
  const deniedByAcl = await postSynthesis(p.token, { type: 'answer', id: APPROVED_ID, revision: 1 }, 'acl-revoked');
  assert.equal(deniedByAcl.status, 503, JSON.stringify(deniedByAcl.body));
  assert.equal(deniedByAcl.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(deniedByAcl.body.error.retryable, true);
  assert.equal(
    Number((await owner.query('SELECT count(*)::int n FROM exports WHERE user_id=$1', [p.id])).rows[0].n),
    sentBeforeRevoked,
    '漏授时不得留下任何账本行（拒绝发生在账本变更之前）',
  );
  assert.equal(transport.calls.length, callsBeforeRevoked, '漏授时不得出站（不得"先外发再记账"）');
  say('P2-c 故障注入②（真 PG + HTTP）：漏授 object_key 列级权限 ⇒ 合成受理 503 PROVIDER_UNAVAILABLE(retryable)，零账本行、零出站');

  await owner.query('GRANT SELECT (object_key), INSERT (object_key) ON exports TO gengyun_egress_ledger');
  assert.deepEqual(await ledgerAcl(), [true, true], 'GRANT 复原后列级授权必须就位');
  const restored = await postSynthesis(p.token, { type: 'answer', id: APPROVED_ID, revision: 1 }, 'acl-restored');
  assert.equal(restored.status, 202, JSON.stringify(restored.body));
  const restoredState = await waitFor(() => terminalJobState(p.token, restored.body.data.id), '授权复原后任务终态');
  assert.equal(restoredState, 'succeeded', 'GRANT 复原后同一路径必须重新成功（证明 503 确由漏授引起）');
  const restoredRow = (await owner.query('SELECT state, object_key, job_id FROM exports WHERE job_id=$1', [restored.body.data.id])).rows[0];
  assert.equal(restoredRow.state, 'sent');
  assert.equal(restoredRow.object_key, `answer:${APPROVED_ID}`);
  say('P2-c 复原（真 PG + HTTP）：GRANT 复原 ⇒ 同一路径重新受理成功并落账（负/正控制成对）');

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

  // ---------------------------------------------------------------- I2. P1-1 回归：同对象版本的并发预留不得跨用户串用
  //
  // 缺陷形态（本片修掉的）：执行期按「对象版本」定位预留行、再回头核对属主，而**两用户可以对同一
  // 对象版本各持一行 `reserved`**（受理时各冻结一次快照）。于是 B 的派发会命中 A 的行 ⇒ A 的外发被
  // 翻成 `sent`、B 的 `job_id` 记到 A 名下（A 的正文在 A 不知情下外发），B 自己的行仍是 `reserved`。
  // 修法：受理处把**任务**绑定到属主（`bindJobOwner`），执行期只按该属主过滤；未绑定 ⇒ 拒绝派发。
  const other = await login(fx('i27-syn-xuser'));
  await grant(other.token, 'external_inference', ['fixture-tts']);
  const callsBefore = transport.calls.length;
  // 本用例之前的合成域账本行数（用于最后断言「被拒的派发零新增行」）。
  const foreignBaseline = Number(
    (await owner.query("SELECT count(*)::int n FROM exports WHERE object_type='checked_content'")).rows[0].n,
  );
  const foreignReservation = await owner.query(
    `INSERT INTO exports(user_id,object_type,object_id,object_key,object_revision,purpose,consent_epoch,recipient_id,recipient_config_version,state,auth_epoch)
     VALUES($1,'checked_content',$2::uuid,$3,1,'external_inference',1,'fixture-tts','fixture-config-v1','reserved',1)
     RETURNING id`,
    [other.id, SENTINEL, `answer:${APPROVED_ID}`],
  );
  const rowsABefore = (await exportRowsFor(p.id)).length;
  const acceptedByA = await postSynthesis(p.token, { type: 'answer', id: APPROVED_ID, revision: 1 });
  assert.equal(acceptedByA.status, 202, JSON.stringify(acceptedByA.body));
  const stateA = await waitFor(() => terminalJobState(p.token, acceptedByA.body.data.id), 'P1-1 用例 A 任务终态');
  assert.equal(stateA, 'succeeded', 'A 的派发必须成功（自己的预留行完好）');
  const rowsA = await exportRowsFor(p.id);
  assert.equal(rowsA.length, rowsABefore + 1, 'A 的这次受理只新增自己的一行');
  const sentByA = rowsA.find((r) => r.state === 'sent' && r.job_id === acceptedByA.body.data.id);
  assert.ok(sentByA !== undefined, 'A 的派发必须把**A 自己的**预留行翻成 sent');
  assert.equal(sentByA.object_key, `answer:${APPROVED_ID}`);
  assert.equal(
    rowsA.filter((r) => r.job_id === acceptedByA.body.data.id).length,
    1,
    '一次派发只能翻转属主自己的一行（不得多翻）',
  );
  // 「回写跟随属主」：回写必须挂在**被翻的那行属主自己的账本行**上，且不含载荷。
  assert.equal(await writebackCount(sentByA.id), 1, 'A 的派发必须给 A 自己的行写回一条');
  const wbA = await writebackFor(sentByA.id);
  assert.equal(wbA.result.content_class, 'structural_only', '回写只落结构类别，不含载荷');
  assert.equal(JSON.stringify(wbA.result).includes('这段正文'), false, '回写不得落提供者载荷/正文');
  assert.equal(JSON.stringify(wbA.result).includes('替身占位产物'), false, '回写不得落产物字节');
  const vRow = (await owner.query('SELECT * FROM exports WHERE id=$1', [foreignReservation.rows[0].id])).rows[0];
  assert.equal(vRow.state, 'reserved', 'B 的预留行不得被 A 的派发消耗（跨用户串用的直接读数）');
  assert.equal(vRow.job_id, null, 'B 的预留行不得被写上 A 的 job_id');
  assert.equal(await writebackCount(vRow.id), 0, 'B 的预留行不得因 A 的派发产生回写');
  assert.equal(transport.calls.length, callsBefore + 1, '只有 A 的派发出站一次（B 没有任务被派发）');
  assert.equal(transport.calls.at(-1).targetRef.id, APPROVED_ID);
  say('P1-1 回归①（真 PG）：A、B 对同一对象版本各持 reserved ⇒ A 的派发只翻 A 自己的行，B 的行仍 reserved、无 job_id、零回写');

  // P1-1 回归②（**先红用例**：确定性复现「不带属主的全局匹配」抢行）
  //
  // 旧实现（被审 sha）的两个事实共同决定了能触发串用的形状：
  //   (1) 预留索引以 `record.objectId` 为键（checked_content 的 objectId 是全零哨兵），而执行期查询用
  //       `input.objectKey`（`answer:<id>`）⇒ 两键永不相等 ⇒ **带属主的候选查询恒为空**，执行期总是退化到
  //       `ledger.findReservedByObject({objectType, objectKey, objectRevision})`（不带属主、以
  //       `ORDER BY created_at DESC LIMIT 1` 取该对象版本上**最新**的 reserved 行）。
  //   (2) 退化结果只在 `owners.size > 0 && !owners.has(unscoped.userId)` 时被拒，而 `owners` 是**该实例进程内
  //       经它 `reserveFor` 过的 user id 集合**（`owners.add(userId)` 位于任何拒绝之前）⇒ 只要「被命中的那行
  //       的属主」在本实例预留过，旧实现就**静默消耗**它（受害者正文在不知情下外发、派发的 `job_id` 记到受害者
  //       名下）；否则才 fail-closed 拒绝。
  // ⇒ 串用与「派发者是谁」无关，只与「被命中那行的属主是否在本实例预留过」有关。因此确定性复现必须同时满足：
  //   派发者自己的行更早、**受害者的行最新**、且受害者是本实例预留过的属主。这里受害者取 `s`（负控制 ③ 的
  //   `rawEgress.withOwner(s.id).reserveForAcceptance` 虽被快照拒绝，但已把 s 记进 `owners`），其受害行走**真实
  //   预留**（不是裸 SQL 造行），派发者用第三个属主；修前：候选为空 ⇒ 命中 s 的最新行 ⇒ s ∈ owners ⇒ 静默串用；
  //   修后：只按绑定属主过滤 ⇒ 只翻派发者自己的行，s 的行保持 reserved。
  //
  // 为什么不能只靠 HTTP 路径复现：受理内「先 reserve 再 dispatch」使派发者自己的预留行必然是该对象版本上最新的
  // 一行，旧实现命中的恰好是它自己那行（行为正确，用例不会红）。
  //
  // 兼容守卫：旧 HEAD 上 `bindJobOwner` 不存在 ⇒ 守卫退化为「不绑定」，那正是旧行为（按对象版本全局匹配），
  // 不是放宽断言；新 HEAD 上它真实登记属主。
  const bindOwner = (target, input) => {
    if (typeof target.bindJobOwner === 'function') target.bindJobOwner(input);
  };
  const thirdOwner = await login(fx('i27-syn-xuser2'));
  await grant(thirdOwner.token, 'external_inference', ['fixture-tts']);
  const ownReservation = await owner.query(
    `INSERT INTO exports(user_id,object_type,object_id,object_key,object_revision,purpose,consent_epoch,recipient_id,recipient_config_version,state,auth_epoch)
     VALUES($1,'checked_content',$2::uuid,$3,1,'external_inference',1,'fixture-tts','fixture-config-v1','reserved',1)
     RETURNING id`,
    [thirdOwner.id, SENTINEL, `answer:${APPROVED_ID}`],
  );
  const ownReservationId = ownReservation.rows[0].id;
  // 受害行：由受害者 `s` 经本实例**真实预留**产生（晚于派发者那行 ⇒ 它是该对象版本上最新的 reserved 行）。
  const victimReserved = await rawEgress.withOwner(s.id).reserveForAcceptance({
    userId: s.id,
    authEpoch: 1,
    contentType: 'answer',
    contentId: APPROVED_ID,
    contentRevision: 1,
  });
  assert.ok(victimReserved !== null, '受害者的真实预留必须成立（否则本用例无从构造）');
  const victimReservationId = victimReserved.exportId;
  // 构造前提（修前/修后都必须成立）：受害行确为该对象版本上**最新**的 `reserved` 行 —— 旧实现的退化查询取它。
  const newestReserved = await owner.query(
    `SELECT id FROM exports WHERE object_type='checked_content' AND object_key=$1 AND object_revision=1
       AND state='reserved' ORDER BY created_at DESC LIMIT 1`,
    [`answer:${APPROVED_ID}`],
  );
  assert.equal(
    newestReserved.rows[0].id,
    victimReservationId,
    '构造前提：受害行必须是该对象版本上最新的 reserved 行（旧实现不带属主的查询取最新一行）',
  );
  const dispatchTransport = syntheticTtsTransport();
  const rawProvider3 = rawEgress.provider(dispatchTransport.provider);
  const ownJobId = randomUUID();
  bindOwner(rawEgress, { jobId: ownJobId, userId: thirdOwner.id });
  await rawProvider3.synthesize({
    jobId: ownJobId,
    text: '跨属主串用回归载荷（测试内合成传输，不出网）',
    locale: 'zh-CN',
    targetRef: { type: 'answer', id: APPROVED_ID, revision: 1 },
  });
  // 缺陷的直接读数：别人的预留行不得被本次派发消耗。
  const victimAfter = (await owner.query('SELECT state, job_id FROM exports WHERE id=$1', [victimReservationId])).rows[0];
  assert.equal(victimAfter.state, 'reserved', '别人的预留行不得被本次派发消耗（跨用户串用的直接读数）');
  assert.equal(victimAfter.job_id, null, '别人的预留行不得被写上本次派发的 job_id');
  assert.equal(await writebackCount(victimReservationId), 0, '别人的预留行不得因本次派发产生回写');
  // 「回写跟随属主」：本次派发只能翻派发者自己那行，回写只能挂在它上面。
  const ownAfter = (await owner.query('SELECT state, job_id FROM exports WHERE id=$1', [ownReservationId])).rows[0];
  assert.equal(ownAfter.state, 'sent', '派发者自己的预留行必须被翻成 sent');
  assert.equal(ownAfter.job_id, ownJobId, '派发者自己的行必须挂本次派发的 job_id');
  assert.equal(await writebackCount(ownReservationId), 1, '回写必须挂在派发者自己的账本行上');
  const ownWb = await writebackFor(ownReservationId);
  assert.equal(ownWb.result.content_class, 'structural_only', '回写只落结构类别，不含载荷');
  assert.equal(dispatchTransport.calls.length, 1, '本次派发只出站一次（测试内合成传输）');
  say('P1-1 回归②（真 PG，先红用例）：受害者 s 的真实 reserved 行比派发者自己的行更新（旧实现的全局查询取它）⇒ 派发只翻派发者自己的行，受害者行仍 reserved、无 job_id、零回写');

  // 负控制 ④：同一对象版本上「别人的预留」不得被消耗；未绑定属主的任务**拒绝派发**（fail-closed）。
  const rawProvider2 = rawEgress.provider({
    available: true,
    unavailableReason: null,
    async synthesize() {
      throw new Error('不应到达真实传输：跨属主/未绑定的派发必须被拒');
    },
  });
  const foreignJobId = randomUUID();
  // 注意：不能用 `other`（B）当被拒属主 —— B 自己就持有该对象版本的 `reserved` 行（本用例直接写入的
  // `foreignReservation`），绑 B 是**合法命中 B 自己的行**，本就该放行。要证明「别人的预留不得被消耗」，
  // 必须绑一个在该对象版本上**没有任何预留行**的第三属主（`t` 的唯一一行是 failed/ACCEPTANCE_FAILED）。
  rawEgress.bindJobOwner({ jobId: foreignJobId, userId: t.id });
  await expectReject(
    rawProvider2.synthesize({
      jobId: foreignJobId,
      text: 'x',
      locale: 'zh-CN',
      targetRef: { type: 'answer', id: APPROVED_ID, revision: 1 },
    }),
    'OBJECT_UNAVAILABLE',
    '在该对象版本上无预留行的属主不得消耗 A/B 的预留行（不得退化成按对象版本全局匹配）',
  );
  await expectReject(
    rawProvider2.synthesize({
      jobId: randomUUID(),
      text: 'x',
      locale: 'zh-CN',
      targetRef: { type: 'answer', id: APPROVED_ID, revision: 1 },
    }),
    'OBJECT_UNAVAILABLE',
    '未绑定属主的任务必须拒绝派发（不得退化成按对象版本全局匹配）',
  );
  const vRowAfter = (await owner.query('SELECT state, job_id FROM exports WHERE id=$1', [foreignReservation.rows[0].id])).rows[0];
  assert.equal(vRowAfter.state, 'reserved', '被拒的跨属主派发不得改动 B 的预留行');
  assert.equal(vRowAfter.job_id, null);
  const aRowAfter = (await owner.query('SELECT state, job_id FROM exports WHERE id=$1', [sentByA.id])).rows[0];
  assert.equal(aRowAfter.state, 'sent', '被拒的派发也不得改动 A 已派发行');
  assert.equal(aRowAfter.job_id, acceptedByA.body.data.id, 'A 的行必须仍挂着 A 自己的 job_id');
  assert.equal(
    Number((await owner.query('SELECT count(*)::int n FROM exports WHERE object_type=$1', ['checked_content'])).rows[0].n),
    foreignBaseline + 4,
    '被拒的派发不得新增账本行（基线已含 P2-c 复原那次受理；此后应有 4 行：A 的第二次受理、本用例直接写入的 B 预留行、回归②直接写入的派发者预留行与受害预留行）',
  );
  say('P1-1 回归③（真 PG）：无预留行的第三属主派发与未绑定属主的派发一律 OBJECT_UNAVAILABLE，零账本变更、零出站');

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
  // P2-c 的故障注入会**撤掉** object_key 的列级授权；任何中途失败都不得把环境留在撤权状态（否则下一次运行
  // 会在「授权已就位」前置上以错误原因红）。这条复原发生在全部断言**之后**，因此不构成「自授后自证」。
  await owner.query('GRANT SELECT (object_key), INSERT (object_key) ON exports TO gengyun_egress_ledger').catch((error) => {
    console.log(`CLEANUP=partial（列级授权复原失败：${String(error.message).slice(0, 200)}）`);
  });
  await owner.end();
  // 复位到确定起点（0014-only），让脚本可反复重跑：0015 是 0014 之上的收紧，本脚本只负责把库还原到
  // 「基线脚本跑完时的样子」。复位失败**不得**吞掉（否则下一次运行会以错误原因红）。
  try {
    const back = restore0014Only();
    console.log(`CLEANUP=done（合成域账本行已清理；库已复位到 0014-only，复位前 col=${back.col} xor=${back.xor} shape=${back.shape}）`);
  } catch (error) {
    console.log(`CLEANUP=partial（账本行已清理，但库状态复位失败：${String(error.message).slice(0, 200)}）`);
  }
}
