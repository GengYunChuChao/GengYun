// GY-S4 P1 真库臂：第三方删除持久化的「记住」面（迁移 0044）
//
// 本片（P1）只让库**记住**第三方删除请求与证据：两条 `SECURITY DEFINER` 函数 + 运行时 EXECUTE +
// 最小权限断言。运行时行为一行未接（P2 才把适配层接上来），所以这条臂**不装配 HTTP**、不 `buildApp`，
// 只有「库 owner 装库 ⇒ 运行时身份调函数 ⇒ 断言库里的真值」这一条线。
//
// 为什么必须用真库（内存替身证明不了这些）：
//   ① `pg_proc` 上的 `prosecdef` / `proconfig` 是**库目录**事实，替身里没有 `pg_proc`；
//   ② 「运行时对表零权限、对函数有 EXECUTE」是 `has_table_privilege` / `has_function_privilege` 的读数；
//   ③ 直插被拒的 SQLSTATE `42501` 只有真库会给；
//   ④ 幂等（重复 `requested` 不刷新 `requested_at`）由 `ON CONFLICT … DO UPDATE` 的 `COALESCE` 决定；
//   ⑤ `confirmed` 缺证据被拒——函数里的 `G0001` 与表上 `third_party_confirmed_evidence` 约束是两层，
//      这条臂要证明**第一层**先挡住（而不是靠 23514 偶然兜住）；
//   ⑥ 终态不可回退（`requested → confirmed → requested` 被拒）由 `DO UPDATE … WHERE` 的单调守卫决定；
//   ⑦ `UP → ROLLBACK → 再 UP`：函数的出现—消失—再出现，只有真库跑 DDL 才算证明；
//   ⑧ 读路径只吐**预期八列**（`RETURNS TABLE` 的形状是库目录事实）。
//
// 与 `account-deletion-pg.mjs` 同形的部分：argv[2] 拿连接串、host 必须 `127.0.0.1`、库名**硬钉**为
// `gengyun_third_party_deletion_test`（防误连）、要求空库、角色与授权语句**从出厂文件原样抽取执行**、
// 收尾按 `pg_roles` 快照差集把本轮新建的角色逐个 DROP 并复核为空。
// 没有 `GY_PG_BIN` 闸门、没有 `exit(77)` 跳过分支：连不上库就是失败（缺库必红）。
//
// 跑法：node tests/integration/third-party-deletion-pg.mjs \
//         postgres://postgres@127.0.0.1:5432/gengyun_third_party_deletion_test
//
// 证据编号（与 `docs/architecture/data-dictionary.md` 的 third_party_deletions 小节对应）：
//   E-S4-P1-A 定义面：两个函数各恰 1 个重载、`prosecdef=true`、`proconfig ⊇ {search_path=pg_catalog,TimeZone=UTC}`
//   E-S4-P1-B 授权面：运行时 EXECUTE=true、表 INSERT/SELECT=false；直插/直读 ⇒ 42501
//   E-S4-P1-C 写语义：幂等 requested（count=1、requested_at 不变）／confirmed 缺证据 ⇒ G0001／
//                       终态不可回退（G0003 且行仍 confirmed）／非法态 `accepted` ⇒ G0001（闭集没有第六值）
//   E-S4-P1-D DDL 可逆：UP ⇒ ROLLBACK ⇒ 再 UP（函数出现—消失—再出现，授权随之消失—再出现）
//   E-S4-P1-E 读语义：`list_*` 运行时可 EXECUTE、只吐八个预期列、固定按 (recipient_id, export_ref) 排序

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

const MIGRATION_FILE = '0044_third_party_deletion_persistence.sql';
const ROLLBACK_FILE = 'rollback/0044_third_party_deletion_persistence.down.sql';

/** 两条函数的**完整参数签名**（`to_regprocedure` / `has_function_privilege` / `DROP FUNCTION` 都要它）。 */
const RECORD_SIGNATURE = 'public.record_third_party_deletion(uuid, text, uuid, text, text, text, timestamptz)';
const LIST_SIGNATURE = 'public.list_third_party_deletions(uuid)';
const RECORD_NAME = 'record_third_party_deletion';
const LIST_NAME = 'list_third_party_deletions';

/** `list_third_party_deletions` 的 `RETURNS TABLE` 列序（八列，写死在这里＝形状契约）。 */
const LIST_COLUMNS = Object.freeze([
  'recipient_id',
  'export_ref',
  'online_state',
  'backup_state',
  'requested_at',
  'confirmed_at',
  'evidence_ref',
  'error_code',
]);

const url = new URL(process.argv[2] ?? 'postgres://postgres@127.0.0.1:5432/gengyun_third_party_deletion_test');
assert.equal(url.hostname, '127.0.0.1', '本测试只允许回环地址');
assert.equal(url.pathname, '/gengyun_third_party_deletion_test', '库名必须硬钉为 gengyun_third_party_deletion_test（防误连）');

const runtimeRole = 'gengyun_api_runtime';
// 与出厂 provisioning **同形**：5 个既有 NOLOGIN 域组（`20-login-roles.sql` 的 A/B/C 段口径）。
// 本片**不新增**任何组角色：函数面的 EXECUTE 直接授给运行时角色本身。
const groups = [
  'gengyun_auth_privacy',
  'gengyun_preview_reader',
  'gengyun_consent_granter',
  'gengyun_profile_runtime',
  'gengyun_knowledge_runtime',
];
const roleFiles = [
  'roles/auth_privacy.sql',
  'roles/catalog_readers.sql',
  'roles/consent_granter.sql',
  'roles/profile_runtime.sql',
  'roles/knowledge_runtime.sql',
];

const password = randomBytes(24).toString('hex');
const sqlFile = (path) => readFileSync(new URL(`../../services/api/db/${path}`, import.meta.url), 'utf8');
const deploySqlFile = (name) => readFileSync(new URL(`../../deploy/postgres-cvm/sql/${name}`, import.meta.url), 'utf8');
const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);

let passed = 0;
const say = (label) => {
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
};
const note = (line) => console.log(`  - ${line}`);

/**
 * 从**出厂文件** `deploy/postgres-cvm/sql/20-login-roles.sql` 的区域标记里抽取第三方删除授权语句并原样执行：
 * 不复制粘贴 SQL（授权语句被删/被改宽 ⇒ 本测试必须变红），并断言 EXECUTE **只**授予运行时角色。
 */
function thirdPartyDeletionGrantRegion() {
  const source = deploySqlFile('20-login-roles.sql');
  const match = /-- #region gy-s4-third-party-deletion-grant\r?\n([\s\S]*?)\r?\n\s*-- #endregion gy-s4-third-party-deletion-grant/.exec(source);
  assert.ok(match !== null, '20-login-roles.sql 里必须有 `-- #region gy-s4-third-party-deletion-grant` 区域（迁移 0044 的 EXECUTE 授权在这里）');
  const region = match[1];
  assert.ok(
    (region.match(/GRANT EXECUTE ON FUNCTION/g) ?? []).length === 2,
    `第三方删除授权区必须恰好两条 GRANT EXECUTE（写路径 + 读路径），实际：${(region.match(/GRANT EXECUTE ON FUNCTION/g) ?? []).length}`,
  );
  assert.ok(
    (region.match(/REVOKE ALL ON FUNCTION/g) ?? []).length === 2,
    `第三方删除授权区必须先把两条函数的 PUBLIC EXECUTE 收回（各一条 REVOKE），实际：${(region.match(/REVOKE ALL ON FUNCTION/g) ?? []).length}`,
  );
  assert.ok(region.includes(RECORD_SIGNATURE), `授权区必须点名写路径 ${RECORD_SIGNATURE}`);
  assert.ok(region.includes(LIST_SIGNATURE), `授权区必须点名读路径 ${LIST_SIGNATURE}`);
  assert.ok(region.includes(` TO ${runtimeRole};`), `授权区只能授给运行时角色 ${runtimeRole}`);
  // 区域必须是**纯 SQL**：它会被本测试原样 `query()`，任何 psql 元命令都会让「原样执行」变成假绿。
  assert.equal(
    /\\(echo|set|pset|if|endif|getenv|gexec)/.test(region),
    false,
    '第三方删除授权区不得含 psql 元命令（它要被原样当 SQL 执行）',
  );
  return region;
}

const owner = new pg.Client({ connectionString: url.href });
await owner.connect();
/** 收工自证用：装载角色文件前先快照，收工后**任何**新出现的角色都必须被清掉。 */
const baselineRoles = new Set((await owner.query('SELECT rolname FROM pg_roles')).rows.map((row) => row.rolname));
const createdRoles = [];
let runtime = null;

const runtimeUrl = () => {
  const scoped = new URL(url.href);
  scoped.username = runtimeRole;
  scoped.password = password;
  return scoped;
};

/** 以运行时身份跑一条语句，把错误**返回**给断言（不抛），便于逐条核对 SQLSTATE。 */
async function runtimeError(text, params = []) {
  try {
    await runtime.query(text, params);
    return null;
  } catch (error) {
    return error;
  }
}

/** 库 owner 视角读一行真值（运行时读不到——它对表零权限）。 */
async function rowAsOwner({ requestId, recipientId, exportRef = null }) {
  const { rows } = await owner.query(
    `SELECT online_status::text AS online_state,
            backup_status::text AS backup_state,
            requested_at, confirmed_at, evidence_ref, error_code
       FROM public.third_party_deletions
      WHERE request_id = $1 AND recipient_id = $2 AND export_ref IS NOT DISTINCT FROM $3::uuid`,
    [requestId, recipientId, exportRef],
  );
  assert.equal(rows.length, 1, `(request_id=${requestId}, recipient_id=${recipientId}, export_ref=${exportRef}) 必须恰好一行`);
  return rows[0];
}

/** 两条函数在 `pg_proc` 里的行数（`public` 命名空间内按名字数，用来证明「恰一个重载」与「消失/再现」）。 */
const functionCount = async () => (await owner.query(
  `SELECT count(*)::int AS n FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = ANY ($1::text[])`,
  [[RECORD_NAME, LIST_NAME]],
)).rows[0].n;

/**
 * 两条函数上**除属主之外**的 EXECUTE ACL 项（`proname → 条数`）。
 * 为什么不查 `has_function_privilege(role, '签名')`：函数不存在时那条函数会把文本 cast 成
 * `regprocedure` 并抛 42883 —— 而「ROLLBACK 之后函数不存在」正是本臂要断言的状态之一。
 * 数 ACL 项对「函数没了」与「函数在但没授权」两种状态都成立。
 */
const nonOwnerExecuteGrants = async () => (await owner.query(
  `SELECT p.proname, count(*)::int AS n
     FROM pg_proc AS p,
          LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = ANY ($1::text[])
      AND a.privilege_type = 'EXECUTE'
      AND a.grantee <> p.proowner
    GROUP BY 1 ORDER BY 1`,
  [[RECORD_NAME, LIST_NAME]],
)).rows;

/** `public`（所有角色）对两条函数的 EXECUTE 读数（迁移里的 `REVOKE ALL … FROM PUBLIC` 是否生效）。 */
const publicExecute = async () => (await owner.query(
  `SELECT $1::text AS sig, has_function_privilege('public', $1, 'EXECUTE') AS ok
   UNION ALL SELECT $2::text, has_function_privilege('public', $2, 'EXECUTE')`,
  [RECORD_SIGNATURE, LIST_SIGNATURE],
)).rows;

/** 运行时角色对两条函数的 EXECUTE 读数（D5 授权区是否生效）。 */
const runtimeExecute = async () => (await owner.query(
  `SELECT $1::text AS sig, has_function_privilege($3, $1, 'EXECUTE') AS ok
   UNION ALL SELECT $2::text, has_function_privilege($3, $2, 'EXECUTE')`,
  [RECORD_SIGNATURE, LIST_SIGNATURE, runtimeRole],
)).rows;

try {
  // ------------------------------------------------------------------ [0] 前置：真库、空库、版本
  const version = (await owner.query('SHOW server_version')).rows[0].server_version;
  assert.match(version, /^17\.11(?:\D|$)/, `本臂只在 PG 17.11 上取证（CI 镜像是 postgres:17.11），实际：${version}`);
  const tableCount = (await owner.query(
    "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'",
  )).rows[0].n;
  assert.equal(tableCount, 0, '本臂要求空库（`public` 下零表）：库必须由运行器现建现跑，不复用既有库');
  say(`前置（真库）：PostgreSQL ${version}、回环地址、空库（public 下 0 表）`);

  // ------------------------------------------------------------------ [1] 装：全链迁移（含 0044）
  const discovered = readdirSync(migrationsDir)
    .filter((name) => /^\d{4,}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const versions = discovered.map((name) => name.slice(0, 4));
  assert.equal(new Set(versions).size, versions.length, `迁移版本号重复：${versions.join(',')}`);
  assert.ok(discovered.includes(MIGRATION_FILE), `迁移清单必须含 ${MIGRATION_FILE}`);
  assert.ok(
    readFileSync(new URL(ROLLBACK_FILE, migrationsDir), 'utf8').includes('DROP FUNCTION IF EXISTS'),
    `${ROLLBACK_FILE} 必须存在且用 DROP FUNCTION IF EXISTS`,
  );
  note(`迁移清单（${discovered.length} 个）：${discovered.join(' ')}`);
  for (const name of discovered) await owner.query(sqlFile(`migrations/${name}`));
  say(`迁移（真库）：${discovered.length} 个按版本序应用成功，含 ${MIGRATION_FILE}`);
  // 迁移只造函数、**不授权**：PUBLIC 的 EXECUTE 已被 `REVOKE ALL … FROM PUBLIC` 收回，且此刻
  // （角色还没建）没有任何非属主拿到 EXECUTE —— 授权完全由 20-login-roles.sql 的 D5 区负责。
  for (const row of await publicExecute()) {
    assert.equal(row.ok, false, `迁移必须把 PUBLIC 的 EXECUTE 收回：${row.sig} 仍可被 public 执行`);
  }
  assert.deepEqual(await nonOwnerExecuteGrants(), [], '迁移阶段不得给任何角色 EXECUTE（授权只由 20-login-roles.sql 的 D5 区负责）');

  // ------------------------------------------------------------------ [2] 最小权限：角色 + D5 授权区
  for (const file of roleFiles) await owner.query(sqlFile(file));
  createdRoles.push(...groups);
  await owner.query(
    `CREATE ROLE ${runtimeRole} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
  );
  createdRoles.push(runtimeRole);
  await owner.query(`GRANT ${groups.join(', ')} TO ${runtimeRole}`);
  await owner.query(thirdPartyDeletionGrantRegion());
  runtime = new pg.Client({ connectionString: runtimeUrl().href });
  await runtime.connect();
  const flags = (await runtime.query(
    'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  )).rows[0];
  assert.ok(Object.values(flags).every((value) => value === false), `运行时角色不得带任何超级位：${JSON.stringify(flags)}`);
  say(`最小权限（真库）：5 个域组 + \`${runtimeRole}\` LOGIN（无超级位），D5 授权区从出厂文件原样抽取并执行`);

  // ------------------------------------------------------------------ [3] ① 定义面
  const definitions = (await owner.query(
    `SELECT p.proname,
            p.prosecdef,
            p.proconfig,
            p.prorettype::regtype::text AS returns,
            p.pronargs,
            p.proargnames,
            p.proargmodes::text[] AS proargmodes,
            pg_get_userbyid(p.proowner) AS owner
       FROM pg_proc AS p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname = ANY ($1::text[])
      ORDER BY p.proname`,
    [[RECORD_NAME, LIST_NAME]],
  )).rows;
  assert.equal(definitions.length, 2, `库目录里必须**恰各一个**重载（两条函数共 2 行），实际 ${definitions.length} 行：${definitions.map((row) => row.proname).join(',')}`);
  for (const definition of definitions) {
    assert.equal(definition.prosecdef, true, `${definition.proname} 必须是 SECURITY DEFINER（prosecdef=true）`);
    assert.ok(
      (definition.proconfig ?? []).includes('search_path=pg_catalog'),
      `${definition.proname} 的 proconfig 必须含 search_path=pg_catalog，实际：${JSON.stringify(definition.proconfig)}`,
    );
    assert.ok(
      (definition.proconfig ?? []).includes('TimeZone=UTC'),
      `${definition.proname} 的 proconfig 必须含 TimeZone=UTC（时刻序列化口径），实际：${JSON.stringify(definition.proconfig)}`,
    );
  }
  // 签名精确到类型：`to_regprocedure` 能解析＝参数类型逐个对得上（不是「同名就行」）。
  const resolved = (await owner.query(
    'SELECT $1::text AS sig, to_regprocedure($1) IS NOT NULL AS ok UNION ALL SELECT $2::text, to_regprocedure($2) IS NOT NULL',
    [RECORD_SIGNATURE, LIST_SIGNATURE],
  )).rows;
  for (const row of resolved) assert.equal(row.ok, true, `签名必须精确存在：${row.sig}`);
  assert.equal(
    definitions.find((row) => row.proname === RECORD_NAME).returns,
    'jsonb',
    '`record_third_party_deletion` 必须返回 jsonb（写入后的整行快照）',
  );
  assert.equal(
    definitions.find((row) => row.proname === LIST_NAME).returns,
    'record',
    '`list_third_party_deletions` 是 RETURNS TABLE（prorettype=record）',
  );
  // `proargnames` 里同时有 IN 参数（`p_request_id`）与 RETURNS TABLE 的输出列 ⇒ 按 `proargmodes='t'` 挑出输出列。
  const listDefinition = definitions.find((row) => row.proname === LIST_NAME);
  const outModes = (listDefinition.proargmodes ?? []).filter((mode) => mode === 't');
  assert.equal(
    outModes.length,
    LIST_COLUMNS.length,
    `\`list_third_party_deletions\` 必须恰好 ${LIST_COLUMNS.length} 个 TABLE 输出列，实际 ${outModes.length}`,
  );
  assert.deepEqual(
    listDefinition.proargnames.filter((_, index) => listDefinition.proargmodes[index] === 't'),
    [...LIST_COLUMNS],
    `\`list_third_party_deletions\` 的输出列必须逐字是这八列（顺序也算）：${LIST_COLUMNS.join(', ')}`,
  );
  say('① 定义面（真库）：两函数各恰 1 个重载、prosecdef=true、proconfig ⊇ {search_path=pg_catalog, TimeZone=UTC}、签名精确、读路径输出列序逐字匹配');
  note(`detail：${definitions.map((row) => `${row.proname}(secdef=${row.prosecdef}, proconfig=[${(row.proconfig ?? []).join(',')}], owner=${row.owner})`).join(' · ')}`);

  // ------------------------------------------------------------------ [4] ② 授权面（表 false / 函数 true）
  const grants = (await owner.query(
    `SELECT has_table_privilege($1, 'public.third_party_deletions', 'INSERT') AS table_insert,
            has_table_privilege($1, 'public.third_party_deletions', 'SELECT') AS table_select,
            has_table_privilege($1, 'public.third_party_deletions', 'UPDATE') AS table_update,
            has_any_column_privilege($1, 'public.third_party_deletions', 'INSERT') AS column_insert,
            has_function_privilege($1, $2, 'EXECUTE') AS record_execute,
            has_function_privilege($1, $3, 'EXECUTE') AS list_execute,
            has_function_privilege('public', $2, 'EXECUTE') AS record_public,
            has_function_privilege('public', $3, 'EXECUTE') AS list_public`,
    [runtimeRole, RECORD_SIGNATURE, LIST_SIGNATURE],
  )).rows[0];
  assert.equal(grants.table_insert, false, '运行时对 `third_party_deletions` 不得有 INSERT');
  assert.equal(grants.table_select, false, '运行时对 `third_party_deletions` 不得有 SELECT（读也要走函数）');
  assert.equal(grants.table_update, false, '运行时对 `third_party_deletions` 不得有 UPDATE');
  assert.equal(grants.column_insert, false, '运行时连列级 INSERT 都不得有');
  assert.equal(grants.record_execute, true, '运行时必须能 EXECUTE 写路径');
  assert.equal(grants.list_execute, true, '运行时必须能 EXECUTE 读路径');
  assert.equal(grants.record_public, false, '`public`（所有角色）不得 EXECUTE 写路径');
  assert.equal(grants.list_public, false, '`public`（所有角色）不得 EXECUTE 读路径');
  // 同两条判据再从**运行时身份自己**读一遍（`current_user` 口径，防「按名字查权限」与真实身份脱节）。
  const selfGrants = (await runtime.query(
    `SELECT current_user AS who,
            has_table_privilege('public.third_party_deletions', 'INSERT') AS table_insert,
            has_table_privilege('public.third_party_deletions', 'SELECT') AS table_select,
            has_function_privilege($1, 'EXECUTE') AS record_execute,
            has_function_privilege($2, 'EXECUTE') AS list_execute`,
    [RECORD_SIGNATURE, LIST_SIGNATURE],
  )).rows[0];
  assert.equal(selfGrants.who, runtimeRole, `运行时连接的身份必须是 ${runtimeRole}，实际：${selfGrants.who}`);
  assert.equal(selfGrants.table_insert, false, '运行时身份：表 INSERT 必须为 false');
  assert.equal(selfGrants.table_select, false, '运行时身份：表 SELECT 必须为 false');
  assert.equal(selfGrants.record_execute, true, '运行时身份：写路径 EXECUTE 必须为 true');
  assert.equal(selfGrants.list_execute, true, '运行时身份：读路径 EXECUTE 必须为 true');
  say('② 授权面（真库）：表 INSERT/SELECT/UPDATE = false（列级也 false）、两函数 EXECUTE = true（public 均 false），运行时身份自读一致');

  // ------------------------------------------------------------------ [5] 合成父行（库 owner 造，运行时造不了也不用造）
  const userId = randomUUID();
  const requestId = randomUUID();
  const exportId = randomUUID();
  await owner.query('INSERT INTO public.users (id) VALUES ($1)', [userId]);
  await owner.query(
    `INSERT INTO public.deletion_requests
       (id, user_id, receipt_hash, generation, online_due_at, backup_due_at, receipt_expires_at)
     VALUES ($1, $2, repeat('a', 64), 1, now() + interval '1 day', now() + interval '2 day', now() + interval '7 day')`,
    [requestId, userId],
  );
  await owner.query(
    `INSERT INTO public.exports
       (id, user_id, object_type, object_id, object_revision, purpose, consent_epoch,
        recipient_id, recipient_config_version, auth_epoch)
     VALUES ($1, $2, 'recording', $3, 1, 'recording', 1, 'recipient-A', 'cfg-1', 1)`,
    [exportId, userId, randomUUID()],
  );
  say('夹具（真库）：1 个用户 + 1 条注销请求 + 1 个导出物（父行由库 owner 造，运行时只走函数）');

  // ------------------------------------------------------------------ [6] ③ 运行时直插/直读 ⇒ 42501
  const insertError = await runtimeError(
    `INSERT INTO public.third_party_deletions
       (request_id, recipient_id, online_status, backup_status, requested_at)
     VALUES ($1, 'recipient-A', 'requested', 'requested', now())`,
    [requestId],
  );
  assert.ok(insertError !== null, '运行时直插 `third_party_deletions` 必须被拒（表对它 forbidden）');
  assert.equal(insertError.code, '42501', `直插必须以 42501（insufficient_privilege）失败，实际：${insertError.code} / ${insertError.message}`);
  const selectError = await runtimeError('SELECT count(*) FROM public.third_party_deletions');
  assert.ok(selectError !== null, '运行时直读 `third_party_deletions` 必须被拒（读也要走函数）');
  assert.equal(selectError.code, '42501', `直读必须以 42501 失败，实际：${selectError.code} / ${selectError.message}`);
  say('③ 拒绝面（真库）：运行时直插 ⇒ 42501、直读 ⇒ 42501（唯一的进出通道是那两条函数）');

  // ------------------------------------------------------------------ [7] ④ 幂等：同键两次 requested
  const firstRequestedAt = '2026-04-01T00:00:00.000Z';
  const secondRequestedAt = '2026-04-01T06:00:00.000Z';
  const firstRecord = (await runtime.query('SELECT public.record_third_party_deletion($1, $2, $3, $4, $5, $6, $7) AS row', [
    requestId, 'recipient-A', null, 'requested', null, null, firstRequestedAt,
  ])).rows[0].row;
  const secondRecord = (await runtime.query('SELECT public.record_third_party_deletion($1, $2, $3, $4, $5, $6, $7) AS row', [
    requestId, 'recipient-A', null, 'requested', null, null, secondRequestedAt,
  ])).rows[0].row;
  assert.equal(firstRecord.requested_at, firstRequestedAt, `首次 requested 必须原样记下 p_at，实际：${firstRecord.requested_at}`);
  assert.equal(secondRecord.requested_at, firstRequestedAt, `重复 requested **不得**刷新 requested_at（幂等），实际：${secondRecord.requested_at}`);
  const afterIdempotent = (await owner.query(
    'SELECT count(*)::int AS n, min(requested_at) AS requested_at FROM public.third_party_deletions WHERE request_id = $1',
    [requestId],
  )).rows[0];
  assert.equal(afterIdempotent.n, 1, `同键连调两次 requested 必须只有 1 行，实际 ${afterIdempotent.n} 行`);
  assert.equal(
    afterIdempotent.requested_at.toISOString(),
    firstRequestedAt,
    `库里的 requested_at 必须停在首次时刻，实际：${afterIdempotent.requested_at.toISOString()}`,
  );
  say(`④ 幂等（真库）：同键连调两次 requested => count=1、requested_at 停在 ${firstRequestedAt}（第二次的 ${secondRequestedAt} 被丢弃）`);

  // ------------------------------------------------------------------ [8] ⑤ confirmed 缺证据 ⇒ 拒绝；非法态 accepted ⇒ 拒绝
  const noEvidenceError = await runtimeError(
    'SELECT public.record_third_party_deletion($1, $2, $3, $4, $5, $6, $7)',
    [requestId, 'recipient-A', null, 'confirmed', null, null, '2026-04-02T00:00:00.000Z'],
  );
  assert.ok(noEvidenceError !== null, 'confirmed 缺 evidence_ref 必须被拒（不许两步 UPDATE 补证据）');
  assert.equal(
    noEvidenceError.code,
    'G0001',
    `confirmed 缺证据必须以模块错误码 G0001（INVALID_REQUEST）失败，实际：${noEvidenceError.code} / ${noEvidenceError.message}`,
  );
  const afterFailedConfirm = await rowAsOwner({ requestId, recipientId: 'recipient-A' });
  assert.equal(afterFailedConfirm.online_state, 'requested', '被拒的 confirmed 不得改动状态（行仍是 requested）');
  assert.equal(afterFailedConfirm.evidence_ref, null, '被拒的 confirmed 不得留下半截证据');
  assert.equal(afterFailedConfirm.confirmed_at, null, '被拒的 confirmed 不得留下 confirmed_at');

  // 闭集负控制：`third_party_state` 只有五个值，没有「受理 / accepted」这一态（P1 明确禁止新增）。
  const acceptedError = await runtimeError(
    'SELECT public.record_third_party_deletion($1, $2, $3, $4, $5, $6, $7)',
    [requestId, 'recipient-A', null, 'accepted', null, null, '2026-04-02T00:00:00.000Z'],
  );
  assert.ok(acceptedError !== null, '非法状态 `accepted` 必须被拒（五值闭集里没有它）');
  assert.equal(
    acceptedError.code,
    'G0001',
    `非法状态必须以 G0001 失败（函数先白名单比对再 cast，不该漏出 22P02），实际：${acceptedError.code} / ${acceptedError.message}`,
  );
  say('⑤ 证据闭合 + 状态闭集（真库）：confirmed 缺 evidence_ref => G0001 且行未被改动；非法态 `accepted` => G0001（不是 22P02）');

  // ------------------------------------------------------------------ [9] ⑥ 单调：requested → confirmed → requested 被拒
  const evidenceRef = 'evidence:third-party-deletion-1';
  const confirmedAt = '2026-04-02T00:00:00.000Z';
  const confirmedRecord = (await runtime.query('SELECT public.record_third_party_deletion($1, $2, $3, $4, $5, $6, $7) AS row', [
    requestId, 'recipient-A', null, 'confirmed', evidenceRef, null, confirmedAt,
  ])).rows[0].row;
  assert.equal(confirmedRecord.online_state, 'confirmed', 'requested → confirmed 必须被接受');
  assert.equal(confirmedRecord.backup_state, 'confirmed', '两个面（online/backup）由单参数一次写同一状态（P1 已知限制）');
  assert.equal(confirmedRecord.evidence_ref, evidenceRef, 'confirmed 必须与证据同一次写齐');
  assert.equal(confirmedRecord.confirmed_at, confirmedAt, `confirmed_at 必须原样记下 p_at，实际：${confirmedRecord.confirmed_at}`);

  const regressError = await runtimeError(
    'SELECT public.record_third_party_deletion($1, $2, $3, $4, $5, $6, $7)',
    [requestId, 'recipient-A', null, 'requested', null, null, '2026-04-03T00:00:00.000Z'],
  );
  assert.ok(regressError !== null, 'confirmed 是终态：再次 requested 必须被拒');
  assert.equal(
    regressError.code,
    'G0003',
    `终态回退必须以模块错误码 G0003（REVISION_CONFLICT）失败，实际：${regressError.code} / ${regressError.message}`,
  );
  const afterRegression = await rowAsOwner({ requestId, recipientId: 'recipient-A' });
  assert.equal(afterRegression.online_state, 'confirmed', '被拒的回退不得改动状态（行仍 confirmed）');
  assert.equal(afterRegression.backup_state, 'confirmed', '两个面都仍 confirmed');
  assert.equal(afterRegression.evidence_ref, evidenceRef, '被拒的回退不得抹掉证据');
  assert.equal(
    afterRegression.confirmed_at.toISOString(),
    confirmedAt,
    `被拒的回退不得刷新 confirmed_at，实际：${afterRegression.confirmed_at.toISOString()}`,
  );
  say(`⑥ 单调（真库）：requested → confirmed(${evidenceRef}) → requested => 第三条 G0003 被拒，行仍 confirmed 且证据/时刻一字未动`);

  // failed 是可重试态：非终态，可被后续 confirmed 覆盖（同一支键、另一接收方 + export_ref）。
  const failedRecord = (await runtime.query('SELECT public.record_third_party_deletion($1, $2, $3, $4, $5, $6, $7) AS row', [
    requestId, 'recipient-B', exportId, 'failed', null, 'PROVIDER_TIMEOUT', '2026-04-04T00:00:00.000Z',
  ])).rows[0].row;
  assert.equal(failedRecord.online_state, 'failed', 'failed 写入必须被接受（带 error_code）');
  assert.equal(failedRecord.error_code, 'PROVIDER_TIMEOUT', 'failed 必须记下 error_code');
  const failedThenConfirmed = (await runtime.query('SELECT public.record_third_party_deletion($1, $2, $3, $4, $5, $6, $7) AS row', [
    requestId, 'recipient-B', exportId, 'confirmed', 'evidence:third-party-deletion-2', null, '2026-04-05T00:00:00.000Z',
  ])).rows[0].row;
  assert.equal(failedThenConfirmed.online_state, 'confirmed', 'failed 不是终态：必须能被后续 confirmed 覆盖');
  assert.equal(failedThenConfirmed.error_code, null, '转为 confirmed 后错误码必须被清掉（否则库里会留着互相矛盾的两条事实）');
  say('⑥b 可重试态（真库）：另一接收方（带 export_ref 那一支）failed → confirmed 覆盖成功，error_code 被清空');

  // ------------------------------------------------------------------ [10] ⑦ UP → ROLLBACK → 再 UP
  assert.equal(await functionCount(), 2, 'UP 之后必须恰两个函数');
  await owner.query(sqlFile(`migrations/${ROLLBACK_FILE}`));
  assert.equal(await functionCount(), 0, 'ROLLBACK 之后两个函数必须消失（`DROP FUNCTION IF EXISTS` 带完整签名）');
  assert.equal(
    (await owner.query('SELECT to_regprocedure($1) IS NULL AS gone', [RECORD_SIGNATURE])).rows[0].gone,
    true,
    'ROLLBACK 之后写路径签名必须解析不到（防「只删了一个重载」）',
  );
  assert.deepEqual(await nonOwnerExecuteGrants(), [], '函数被删掉后，挂在它上面的 EXECUTE 授权必须一并消失（ACL 属于函数对象）');

  await owner.query(sqlFile(`migrations/${MIGRATION_FILE}`));
  assert.equal(await functionCount(), 2, '再 UP 之后两个函数必须重新出现');
  for (const row of await runtimeExecute()) {
    assert.equal(row.ok, false, `再 UP 之后 EXECUTE 必须**还没**授（授权是 D5 的职责，不能藏在迁移里）：${row.sig}`);
  }

  await owner.query(thirdPartyDeletionGrantRegion());
  for (const row of await runtimeExecute()) {
    assert.equal(row.ok, true, `重跑 D5 后运行时 EXECUTE 必须恢复：${row.sig}`);
  }
  assert.deepEqual(
    (await nonOwnerExecuteGrants()).map((row) => [row.proname, row.n]),
    [[LIST_NAME, 1], [RECORD_NAME, 1]],
    '重跑 D5 后两条函数各有**唯一**一条非属主 EXECUTE 授权（就是运行时角色那条）',
  );
  say('⑦ DDL 可逆（真库）：UP(2 个函数、PUBLIC 已收回) → ROLLBACK(0 个、ACL 随之消失) → 再 UP(2 个、运行时 EXECUTE 仍 false) → 重跑 D5(EXECUTE 恢复，各恰 1 条)');

  // ------------------------------------------------------------------ [11] ⑧ 读路径：运行时 EXECUTE、只吐八列、固定排序
  // 先补一条**没有 export_ref** 的接收方，让排序判据有三个可比较的对象。
  await runtime.query('SELECT public.record_third_party_deletion($1, $2, $3, $4, $5, $6, $7)', [
    requestId, 'recipient-C', null, 'unsupported', null, 'RECIPIENT_NO_API', '2026-04-06T00:00:00.000Z',
  ]);
  const listed = (await runtime.query('SELECT * FROM public.list_third_party_deletions($1)', [requestId])).rows;
  assert.equal(listed.length, 3, `该请求应有 3 条第三方删除记录（A/B/C），实际 ${listed.length} 条`);
  assert.deepEqual(
    Object.keys(listed[0]),
    [...LIST_COLUMNS],
    `list_* 必须只吐这八列（顺带证明没漏出内部列），实际：${Object.keys(listed[0]).join(',')}`,
  );
  assert.deepEqual(
    listed.map((row) => row.recipient_id),
    ['recipient-A', 'recipient-B', 'recipient-C'],
    `list_* 必须按 (recipient_id, export_ref) 固定排序，实际：${listed.map((row) => row.recipient_id).join(' → ')}`,
  );
  const [rowA, rowB, rowC] = listed;
  assert.equal(rowA.online_state, 'confirmed', `rowA 状态必须仍是 confirmed，实际：${rowA.online_state}`);
  assert.equal(rowA.requested_at, firstRequestedAt, 'rowA 的 requested_at 必须还是首次受理时刻（读路径与写路径同口径）');
  assert.equal(rowA.confirmed_at, confirmedAt, 'rowA 的 confirmed_at 必须原样回读');
  assert.equal(rowA.evidence_ref, evidenceRef, 'rowA 的证据必须原样回读');
  assert.equal(rowB.export_ref, exportId, 'rowB 必须带着它的 export_ref');
  assert.equal(rowB.online_state, 'confirmed', 'rowB 是 failed→confirmed 覆盖后的终态');
  assert.equal(rowC.online_state, 'unsupported', 'unsupported 也必须能记住（终态但不带证据）');
  assert.equal(rowC.error_code, 'RECIPIENT_NO_API', 'unsupported 的错误码/原因必须原样回读');
  assert.equal(
    (await runtime.query('SELECT count(*)::int AS n FROM public.list_third_party_deletions($1)', [randomUUID()])).rows[0].n,
    0,
    '不存在的请求必须返回零行（不抛错：读路径对空集是正常状态）',
  );
  say('⑧ 读语义（真库）：运行时 EXECUTE `list_*` 成功 => 3 行、恰好八列、按 (recipient_id, export_ref) 排序、写进去的值逐字回读、未知请求零行');

  // ------------------------------------------------------------------ [12] 收工读数
  console.log(
    `\nRESULT=PASS ${passed} 组；真实 PostgreSQL ${version}（本机隔离、仅回环）；未发出任何对外付费请求；发现迁移 ${discovered.length} 个`,
  );
} finally {
  await runtime?.end?.().catch(() => {});
  for (const role of [...createdRoles].reverse()) {
    await owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`).catch(() => {});
    await owner.query(`DROP OWNED BY ${role}`).catch(() => {});
    await owner.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  }
  // 角色文件会顺带建出别的角色（例如 `gengyun_evidence_reader`）：按**快照差集**清，不容残留。
  const leftover = (await owner.query('SELECT rolname FROM pg_roles')).rows
    .map((row) => row.rolname)
    .filter((name) => !baselineRoles.has(name));
  for (const role of leftover) {
    await owner.query(`DROP OWNED BY ${role}`).catch(() => {});
    await owner.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  }
  const residue = (await owner.query('SELECT rolname FROM pg_roles')).rows
    .map((row) => row.rolname)
    .filter((name) => !baselineRoles.has(name));
  await owner.end();
  if (residue.length > 0) throw new Error(`收工残留角色（必须人工清理并查明）：${residue.join(', ')}`);
  console.log('CLEANUP=done（运行时 LOGIN 与本次新建的所有角色已清理并复核为空；库由运行器删除）');
}
