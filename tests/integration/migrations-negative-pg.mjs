/** GY-I02 · 迁移器（`services/api/src/db/migrate.ts`）的三条负例路径，仅连回环真 PG17.11。
 *
 * 三臂（派单要求逐臂可读）：
 *   A 半截失败：迁移在中途报错 ⇒ 退出码非 0，且**同一次迁移里已经成功执行的 DDL 全部回滚**，台账不留行；
 *   B 重放：对已迁移的库再跑同一批迁移 ⇒ 台账幂等跳过（`已应用：（无）`），绝不把任何语句再执行一次；
 *   C 回滚：既有 0016 先 up 再跑 `migrations/rollback/0016_*.down.sql` ⇒ up 前不存在的对象在 down 后消失。
 *
 * 真库不可用时**显式 SKIP 并打印原因**（退出码 77＝未取得，绝非静默绿；本机可显式 `--allow-skip` 取 0）：
 *   MIGRATIONS_NEGATIVE_TEST_URL=postgres://postgres@127.0.0.1:55441/postgres
 * 维护连接须能 CREATE/DROP DATABASE；本文件自建并在收尾时删除 `gengyun_migrations_negative_{a,b,c}`，
 * 以及**本臂专用的维护库** `gengyun_migrations_negative_maint`（a/b/c 的建/删都走它，不借用任何别的臂
 * 正在用的库；收尾断言 `pg_database` 里以 `gengyun_migrations_negative_` 开头的库为 0）。
 * 收尾**不吞错**：删库失败必须让本步红（同形状的 `.catch(() => {})` 实测会静默留下库并照绿）。
 * 未在本文件里覆盖的：runner 没有 `down` 命令、既有 down 脚本不回写 `schema_migrations`（见验证页「已知缺口」）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';

const rawUrl = (process.env.MIGRATIONS_NEGATIVE_TEST_URL ?? '').trim();
// 缺真库时的出口：默认 77（未取得，不是通过）；只有显式 `--allow-skip` / `GY_ALLOW_SKIP=1` 才降级为 0。
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
if (rawUrl === '') {
  console.log('SKIP migrations-negative-pg：MIGRATIONS_NEGATIVE_TEST_URL 未设置，三臂 A/B/C 均未执行（不算通过）。');
  console.log('  原因：半截失败／重放／回滚必须对真实 PostgreSQL 17.11 取证，无库时不伪造读数，也不静默绿。');
  console.log('  启用：MIGRATIONS_NEGATIVE_TEST_URL=postgres://<user>@127.0.0.1:<port>/<test_db>（维护连接须可 CREATE/DROP DATABASE）。');
  if (ALLOW_SKIP) {
    console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
    process.exit(0);
  }
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。');
  process.exit(77);
}

const url = new URL(rawUrl);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'postgres:// URL only');
assert.equal(url.search, '', 'no pg URL override options');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'loopback only');
const maintenanceDb = decodeURIComponent(url.pathname.replace(/^\//, ''));
assert.ok(
  maintenanceDb === 'postgres' || maintenanceDb.endsWith('_test'),
  'disposable test maintenance DB only（库名为 postgres 或 *_test）',
);

/** 迁移总数由迁移器自清点，取数来源与 runner（`discoverMigrations()` 默认参数 `DEFAULT_MIGRATIONS_DIR`）完全相同。
 *  **刻意不写死总数 16**：合流时（2026-10-18）在飞分支已各带一条新迁移（0017／0018），
 *  写死数字会让「新增迁移先合入」把本测试变成时炸弹。改用两条**结构不变量**：
 *    ① 版本序列在 1..max 上连续无缺号（缺号点名到具体版本）；
 *    ② 总数 === 最大版本号（编号自 0001 起、无错位）。
 *  二者对「新增迁移」自动放行，对「发现器静默漏项」变红（实测变异：发现器跳过 0015 ⇒ 两条各自都会红）。
 *  纯派生（只把 `discoverMigrations().length` 与自身比）曾实测无牙：同一次漏片下本测试仍 11/11 绿。
 *
 *  **①② 的真空洞（2026-10-21 补）**：两条都只约束「已发现集合的内部一致性」，对「发现器把**尾部整段**
 *  漏掉」恒真——只剩 0001..0019 时序列照样连续、count 照样等于 max，脚本照绿。故在 ①② 之后另加两条
 *  **下限钉**（`MIN_EXPECTED_LAST_VERSION`，见常量处的注释）：它挡的是「尾部整段丢失」这一类漏项，
 *  ⛔ 不是「必须等于某个数」，具体理由与实测见 docs/verification/gy-r28-migrations-negative-floor-20261021.md。 */
const MIGRATIONS = discoverMigrations();
const MIGRATION_COUNT = MIGRATIONS.length;
const VERSION_NUMBER_SET = new Set(MIGRATIONS.map((migration) => Number(migration.version)));
const LAST_VERSION_NUMBER = Math.max(...VERSION_NUMBER_SET);
const MISSING_VERSIONS = [];
for (let expected = 1; expected <= LAST_VERSION_NUMBER; expected += 1) {
  if (!VERSION_NUMBER_SET.has(expected)) MISSING_VERSIONS.push(String(expected).padStart(4, '0'));
}
assert.deepEqual(
  MISSING_VERSIONS,
  [],
  `迁移版本号必须在 1..${LAST_VERSION_NUMBER} 上连续无缺号（缺号＝发现器静默漏项：${MISSING_VERSIONS.join(', ')}）`,
);
assert.equal(
  MIGRATION_COUNT,
  LAST_VERSION_NUMBER,
  `迁移总数必须等于最大版本号（编号自 0001 起、无错位；实测 count=${MIGRATION_COUNT}，max=${LAST_VERSION_NUMBER}）`,
);

/** 最大号下限钉：**有意的人工步骤** —— 新增迁移时**须**把这里抬到新的最大版本号（与 0001 起的编号同号）。
 *
 *  为什么是「≥」而不是「必须等于某个数」：
 *    · 下限只挡**尾部整段丢失**这类漏项（2026-10-21 实测：工作树副本删掉末 3 个迁移后，①② 仍绿、本条红）；
 *    · 别人先合入一条新迁移、本文件后合入时，数字**落后**只会让钉子变松（25 ≤ 26 照样绿），
 *      不会把「新增迁移先合入」变成时炸弹——这正是 ①② 当初拒绝写死总数的原因，下限钉不退回那个坑；
 *    · 漏抬钉子不会制造新故障，只损失一点灵敏度：尾部丢失若仍留在 ≥ 本数之上，本钉看不见（如实登记为缺口）。
 *  与 ①② 的分工：①② 管「中间缺号／编号错位」，本钉管「末尾整段不见」——后者是前两条的结构盲区。
 *  同一条人工步骤也要同步 `MIGRATION_COUNT` 的下限断言（下面两条断言共用本常量）。 */
const MIN_EXPECTED_LAST_VERSION = 25;

/** 结构不变量读数：负控制里这一行必须出现（证明旧两条仍绿），紧随其后才是下限钉的判决。 */
console.log(
  `STRUCT 旧的两条结构不变量已通过：${MIGRATION_COUNT} 个迁移，版本 0001..` +
    `${String(LAST_VERSION_NUMBER).padStart(4, '0')} 连续无缺号，count === max（不写死总数）。`,
);
assert.ok(
  LAST_VERSION_NUMBER >= MIN_EXPECTED_LAST_VERSION,
  `最大迁移版本号不得低于下限钉 ${MIN_EXPECTED_LAST_VERSION}（实测 max=${LAST_VERSION_NUMBER}）：` +
    '这条挡的是「迁移发现器把尾部整段漏掉」——例如只剩 0001..0019 时，① 连续无缺号与 ② count===max ' +
    '会同时成立，旧两条结构不变量对此恒真、只有本条会红。它不是「必须等于某个数」：新增迁移只须把下限钉' +
    '同步抬到新号（有意的人工步骤），不相等不报错，只有整段尾巴消失才红。',
);
assert.ok(
  MIGRATION_COUNT >= MIN_EXPECTED_LAST_VERSION,
  `迁移总数不得低于下限钉 ${MIN_EXPECTED_LAST_VERSION}（实测 count=${MIGRATION_COUNT}）：` +
    '与上一条同源（② 保证 count===max），但仍单列一条——将来若有人松动 ②，总数这一列的下限仍在，' +
    '尾部整段丢失依旧会红；同样只比「≥」，不要求等于任何数。',
);

const LAST_VERSION = MIGRATIONS[MIGRATION_COUNT - 1].version;
/** 「0016 待应用」现场：全部迁移已应用，只把最后一片的台账行删掉。 */
const PENDING_LEDGER = MIGRATION_COUNT - 1;

const apiDir = fileURLToPath(new URL('../../services/api/', import.meta.url));
const SQL_0016_DOWN = 'migrations/rollback/0016_account_deletion_persistence.down.sql';
const FUNCTION_0016 =
  'public.request_account_deletion(uuid,uuid,text,integer,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz)';
const DATABASES = ['a', 'b', 'c'].map((suffix) => `gengyun_migrations_negative_${suffix}`);
/** 本臂**专用维护库**：a/b/c 的建/删都走它，绝不借用别的臂正在用的库（与 `auth-privacy` 共用一库时，
 *  一端残留会掩另一端）。收尾必须删掉并断言 `pg_database` 不残留（见 D1/D2 与 finally）。
 *  名字刻意落在 `gengyun_migrations_negative_` 前缀里：收尾的「残留 = 0」断言自动覆盖它。 */
const MAINT_DATABASE = 'gengyun_migrations_negative_maint';
/** 负控制用的诱饵库：只在 D1 里造/删，用来证明「遗留探测器」不是恒真空转。 */
const DECOY_DATABASE = 'gengyun_migrations_negative_decoy';
/** 本臂拥有的一切库名都以它开头；收尾断言「以它开头的库 = 0」。 */
const DATABASE_PREFIX = 'gengyun_migrations_negative_';
/** 0016 的全部可观测对象都不存在时（`up` 之前 / `down` 之后）的快照。 */
const ABSENT_0016 = { columns: [], index_definition: null, constraint_present: false, function_present: false };

const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
const opened = [];
const tmpRoots = [];
let passed = 0;
const say = (text) => {
  passed++;
  console.log(`PASS ${passed}: ${text}`);
};
const sqlFile = (path) => readFileSync(new URL(`../../services/api/db/${path}`, import.meta.url), 'utf8');
const databaseUrl = (name) => {
  const scoped = new URL(url.href);
  scoped.pathname = `/${name}`;
  return scoped.href;
};
async function connect(name) {
  const client = new pg.Client({ connectionString: databaseUrl(name) });
  await client.connect();
  opened.push(client);
  return client;
}
/** 删库/建库只走 `admin`（连在 env 指定的基准库上，CI 里是内建 `postgres` 库）。 */
async function dropDatabase(name) {
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}
async function createDatabase(name) {
  await dropDatabase(name);
  await admin.query(`CREATE DATABASE ${name}`);
}
/** 以 `pg_database` 为准的「本臂遗留库」清单；收尾断言与 D1 负控制共用同一个探测器。 */
async function leftoverDatabases() {
  const result = await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY 1', [
    `${DATABASE_PREFIX}%`,
  ]);
  return result.rows.map((row) => row.datname);
}
/** 维护连接：连到本臂专用维护库（既不是被测库，也不是任何别的臂的库）。 */
let maint;
async function openMaint() {
  maint = new pg.Client({ connectionString: databaseUrl(MAINT_DATABASE) });
  await maint.connect();
}
async function resetDatabase(name) {
  await maint.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
}
/** 用与 CI / 本机完全相同的一条命令跑迁移器，取真实退出码与 stdout/stderr。 */
function runUp(name) {
  return spawnSync(process.execPath, ['src/db/migrate.ts', 'up'], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: databaseUrl(name) },
    encoding: 'utf8',
  });
}
async function ledgerRows(client) {
  const result = await client.query(
    'SELECT version, name, checksum, applied_at::text AS applied_at FROM schema_migrations ORDER BY version',
  );
  return result.rows.map(
    (row) => `${row.version} ${row.name} ${String(row.checksum).trim()} ${String(row.applied_at)}`,
  );
}
async function publicObjects(client) {
  const result = await client.query(
    "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'",
  );
  return result.rows[0].n;
}
async function snapshot0016(client) {
  const columns = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'deletion_requests'
        AND column_name = ANY($1::text[]) ORDER BY column_name`,
    [['user_id', 'receipt_issued_at', 'receipt_expires_at']],
  );
  const index = await client.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'deletion_requests_user_requested_idx'`,
  );
  const constraint = await client.query(
    `SELECT conname FROM pg_constraint WHERE conname = 'deletion_requests_receipt_validity'`,
  );
  const fn = await client.query('SELECT to_regprocedure($1) AS oid', [FUNCTION_0016]);
  return {
    columns: columns.rows.map((row) => String(row.column_name)),
    index_definition: index.rows.length === 1 ? String(index.rows[0].indexdef) : null,
    constraint_present: constraint.rows.length === 1,
    function_present: fn.rows[0].oid !== null && fn.rows[0].oid !== undefined,
  };
}
/** 在系统临时目录里造一套合成迁移（不写进仓内固定迁移目录）。 */
function syntheticDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'migneg-'));
  tmpRoots.push(dir);
  for (const [filename, sql] of Object.entries(files)) writeFileSync(join(dir, filename), sql, 'utf8');
  return dir;
}

let bodyFailure = null;
let baseObjectsBefore = 0;
try {
  const version = String((await admin.query('SHOW server_version')).rows[0].server_version);
  assert.ok(version.startsWith('17.11'), `native PG17.11 required, got ${version}`);

  // 开跑前先清掉上次崩溃/并行留下的本臂库：否则 A/B/C 的现场不是「空库」，读数不可比。
  for (const stale of await leftoverDatabases()) await dropDatabase(stale);
  assert.deepEqual(await leftoverDatabases(), [], '开跑前本臂库必须为零（上次残留已清）');
  baseObjectsBefore = await publicObjects(admin);

  // ---- D1 负控制（CI 每次跑）：诱饵库必须被「遗留探测器」抓到 → 清掉 → 探测器归零。
  // 若探测器恒返回空（空转），第一条断言就红；这是收尾断言「不残留」不是真空转的证据。
  await createDatabase(MAINT_DATABASE);
  await openMaint();
  assert.deepEqual(await leftoverDatabases(), [MAINT_DATABASE], '维护库是开跑前唯一允许存在的本臂库');
  await createDatabase(DECOY_DATABASE);
  assert.deepEqual(
    (await leftoverDatabases()).filter((name) => name !== MAINT_DATABASE),
    [DECOY_DATABASE],
    '遗留探测器必须抓到诱饵库（否则收尾「残留 = 0」断言是空转）',
  );
  await dropDatabase(DECOY_DATABASE);
  assert.deepEqual(
    (await leftoverDatabases()).filter((name) => name !== MAINT_DATABASE),
    [],
    '诱饵库清掉后遗留探测器必须归零',
  );
  say('D1 遗留库负控制：诱饵库被抓到 → 清掉 → 探测器归零（收尾断言非空转）');

  const [DB_A, DB_B, DB_C] = DATABASES;

  // ===========================================================================
  // 臂 A：半截失败必须回滚干净（真迁移 + 真 CLI 退出码 + 合成文件字面复核）
  // ===========================================================================
  await resetDatabase(DB_A);
  const a = await connect(DB_A);
  let run = runUp(DB_A);
  assert.equal(run.status, 0, `基线全量迁移必须成功；stderr=${run.stderr}`);
  assert.match(run.stdout, new RegExp(`发现 ${MIGRATION_COUNT} 个迁移`));
  assert.match(run.stdout, /已应用：0001/);
  assert.equal((await ledgerRows(a)).length, MIGRATION_COUNT);
  say(`A0 基线：空库 \`up\` 依次应用 0001–${LAST_VERSION}，台账 ${MIGRATION_COUNT} 行（三臂的前提现场可复现）`);

  // 把现场倒回「0001…0015 已应用、0016 待应用」：跑既有 down 脚本 + 删台账行
  // （既有 down 脚本不回写台账，这正是文档里记录的已知缺口）。
  await a.query(sqlFile(SQL_0016_DOWN));
  await a.query("DELETE FROM schema_migrations WHERE version = '0016'");
  assert.deepEqual(await snapshot0016(a), ABSENT_0016, '倒回现场后 0016 的四类对象必须都不存在');
  assert.equal((await ledgerRows(a)).length, PENDING_LEDGER);
  say(`A1 现场置回「0016 待应用」：四类对象计数 0、台账 ${PENDING_LEDGER} 行`);

  // 注入冲突：先占住 0016 第 2 条语句要建的索引名，让迁移在「第 1 条 ALTER 已成功」之后失败。
  await a.query('CREATE INDEX deletion_requests_user_requested_idx ON public.deletion_requests (requested_at)');
  const injected = await snapshot0016(a);
  assert.match(injected.index_definition, /\(requested_at\)/, '冲突索引由本测试注入');

  run = runUp(DB_A);
  assert.equal(run.status, 1, '半截失败的 `up` 必须非 0 退出');
  assert.match(run.stderr, /迁移 0016_account_deletion_persistence\.sql 执行失败：/);
  assert.match(run.stderr, /迁移失败：/);
  const afterFailure = await snapshot0016(a);
  assert.deepEqual(afterFailure.columns, [], '先前已成功的 ALTER 三列必须被回滚');
  assert.equal(afterFailure.constraint_present, false, '同一条 ALTER 加的 CHECK 必须被回滚');
  assert.equal(afterFailure.function_present, false);
  assert.match(afterFailure.index_definition, /\(requested_at\)/, '注入的冲突索引仍在 ⇒ 失败确由注入冲突引起');
  const ledgerAfterFailure = await ledgerRows(a);
  assert.equal(ledgerAfterFailure.length, PENDING_LEDGER, '半截失败不得让台账多出 0016 行');
  assert.ok(!ledgerAfterFailure.some((row) => row.startsWith('0016 ')), '台账里不得出现 0016');
  say(`A2 半截失败：退出码 1，0016 的三列/CHECK/函数全被回滚，台账仍 ${PENDING_LEDGER} 行且无 0016 行`);

  // 解除冲突后 `up` 必须补上 ⇒ 失败可归因于注入冲突，而不是迁移器自身缺陷。
  await a.query('DROP INDEX public.deletion_requests_user_requested_idx');
  run = runUp(DB_A);
  assert.equal(run.status, 0, `解除冲突后的 \`up\` 必须成功；stderr=${run.stderr}`);
  assert.match(run.stdout, /已应用：0016/);
  const recovered = await snapshot0016(a);
  assert.deepEqual(recovered.columns, ['receipt_expires_at', 'receipt_issued_at', 'user_id']);
  assert.equal(recovered.constraint_present, true);
  assert.equal(recovered.function_present, true);
  assert.match(recovered.index_definition, /user_id, requested_at DESC, id DESC/);
  assert.equal((await ledgerRows(a)).length, MIGRATION_COUNT);
  say(`A3 冲突解除后 \`up\` 补上 0016：四类对象与 ${MIGRATION_COUNT} 行台账全部恢复`);

  // A4：迁移文件字面「先建表、后写坏语句」——半截失败不留表、不留台账行。
  const halfBroken = syntheticDir({
    '0099_half_broken.sql': 'CREATE TABLE public.migneg_half_broken_probe (id integer PRIMARY KEY);\nTHIS IS NOT SQL;\n',
  });
  await assert.rejects(
    applyMigrations(a, discoverMigrations(halfBroken)),
    /迁移 0099_half_broken\.sql 执行失败：/,
    '坏语句必须让 applyMigrations 抛错',
  );
  const probe = await a.query("SELECT to_regclass('public.migneg_half_broken_probe') AS oid");
  assert.equal(probe.rows[0].oid, null, '半截失败不得留下已建的表');
  assert.equal((await ledgerRows(a)).length, MIGRATION_COUNT, '半截失败不得写台账行（0099）');
  say('A4 合成迁移「先建表后写坏语句」：抛错、建表被回滚、台账无 0099 行');

  // A5/A6：证明迁移器自身的 per-migration BEGIN/COMMIT 是承重的。
  // 0016 这类文件自带 BEGIN…COMMIT，合成 0099 又是单条多语句（PG 隐式事务兜底），
  // 二者都测不出 runner 去掉 BEGIN 的后果；这里用一个**不带** BEGIN 的合成迁移，
  // 只把「台账 INSERT」弄失败，看同一迁移里已执行的建表是否残留。
  const noBegin = syntheticDir({
    '0100_no_begin_probe.sql': 'CREATE TABLE public.migneg_no_begin_probe (id integer PRIMARY KEY);\n',
  });
  const noBeginMigrations = discoverMigrations(noBegin);
  assert.equal(noBeginMigrations.length, 1);
  await applyMigrations(a, noBeginMigrations);
  const afterNoBegin = await a.query("SELECT to_regclass('public.migneg_no_begin_probe') AS oid");
  assert.notEqual(afterNoBegin.rows[0].oid, null, '正控：无 BEGIN 的迁移在正常路径下必须落地');
  assert.equal((await ledgerRows(a)).length, MIGRATION_COUNT + 1);
  await a.query('DROP TABLE public.migneg_no_begin_probe');
  await a.query("DELETE FROM schema_migrations WHERE version = '0100'");
  assert.equal((await ledgerRows(a)).length, MIGRATION_COUNT);
  say(`A5 事务正控：不带 \`BEGIN\` 的合成迁移 0100 由迁移器事务包住，正常路径落地且台账 +1，复原后台账 ${MIGRATION_COUNT} 行`);

  const ledgerFails = {
    async query(text, values) {
      if (typeof text === 'string' && text.startsWith('INSERT INTO schema_migrations')) {
        throw new Error('probe-ledger-write-failure');
      }
      return a.query(text, values);
    },
  };
  await assert.rejects(
    applyMigrations(ledgerFails, noBeginMigrations),
    /迁移 0100_no_begin_probe\.sql 执行失败：probe-ledger-write-failure/,
    '台账写入失败必须让 applyMigrations 抛错',
  );
  const leaked = await a.query("SELECT to_regclass('public.migneg_no_begin_probe') AS oid");
  assert.equal(leaked.rows[0].oid, null, '台账写入失败后，同一迁移里已执行的建表必须被回滚（证明 BEGIN 承重）');
  assert.equal((await ledgerRows(a)).length, MIGRATION_COUNT, '失败的迁移不得留下台账行');
  say('A6 事务负例：台账 INSERT 失败后，无 `BEGIN` 迁移里已建的表不残留、台账无行（runner 的 BEGIN 承重）');

  // ===========================================================================
  // 臂 B：重放不得部分再执行
  // ===========================================================================
  await resetDatabase(DB_B);
  const b = await connect(DB_B);
  run = runUp(DB_B);
  assert.equal(run.status, 0, `B 臂基线 \`up\` 必须成功；stderr=${run.stderr}`);
  assert.match(run.stdout, /已存在跳过：（无）/);
  const ledgerBeforeReplay = await ledgerRows(b);
  assert.equal(ledgerBeforeReplay.length, MIGRATION_COUNT);
  // 台账之外的哨兵：重放既不得删表，也不得重复执行任何 DDL/DML。
  await b.query('CREATE TABLE public.migneg_replay_sentinel (id integer PRIMARY KEY)');
  await b.query('INSERT INTO public.migneg_replay_sentinel (id) VALUES (1)');
  const objectsBeforeReplay = await publicObjects(b);

  run = runUp(DB_B);
  assert.equal(run.status, 0, `重放必须幂等成功；stderr=${run.stderr}`);
  assert.match(run.stdout, /已应用：（无）/);
  assert.match(run.stdout, new RegExp(`已存在跳过：0001, 0002`));
  assert.match(run.stdout, new RegExp(LAST_VERSION));
  assert.deepEqual(await ledgerRows(b), ledgerBeforeReplay, '重放不得改台账（版本/校验和/applied_at 全不变）');
  assert.equal(await publicObjects(b), objectsBeforeReplay, '重放入口不得新建或删除 public 对象');
  const sentinel = await b.query('SELECT count(*)::int AS n FROM public.migneg_replay_sentinel');
  assert.equal(sentinel.rows[0].n, 1);
  say(`B1 重放：退出码 0，\`已应用：（无）\`＋\`已存在跳过：0001…${LAST_VERSION}\`，台账指纹/对象数/哨兵行完全不变`);

  // B2：磁盘文件被改（drift）⇒ 明确失败且状态不变，这是「重放」的另一个合法结局。
  const tampered = syntheticDir({ '0001_tampered.sql': 'SELECT 1;\n' });
  await assert.rejects(
    applyMigrations(b, discoverMigrations(tampered)),
    /迁移校验和 drift，拒绝继续：0001\(/,
    'drift 必须拒绝执行',
  );
  assert.deepEqual(await ledgerRows(b), ledgerBeforeReplay, 'drift 拒绝后台账不得变');
  assert.equal(await publicObjects(b), objectsBeforeReplay, 'drift 拒绝后不得有 DDL 发生');
  say('B2 drift：篡改 0001 的磁盘内容后抛「迁移校验和 drift，拒绝继续」，台账与对象数不变');

  // ===========================================================================
  // 臂 C：up→down 可逆（既有 0016 的 up 与 rollback/0016 的 down）
  // ===========================================================================
  await resetDatabase(DB_C);
  const c = await connect(DB_C);
  const beforeUp = await snapshot0016(c);
  assert.deepEqual(beforeUp, ABSENT_0016, '全新库 up 之前 0016 的对象一律不存在');

  run = runUp(DB_C);
  assert.equal(run.status, 0, `C 臂 \`up\` 必须成功；stderr=${run.stderr}`);
  const afterUp = await snapshot0016(c);
  assert.deepEqual(afterUp.columns, ['receipt_expires_at', 'receipt_issued_at', 'user_id']);
  assert.equal(afterUp.constraint_present, true);
  assert.equal(afterUp.function_present, true);
  assert.match(afterUp.index_definition, /user_id, requested_at DESC, id DESC/);

  await c.query(sqlFile(SQL_0016_DOWN));
  const afterDown = await snapshot0016(c);
  assert.deepEqual(afterDown, beforeUp, 'down 后必须与 up 前逐字段一致（up 前不存在的对象全部消失）');
  say('C1 0016 up→down：四类对象回到 up 前状态，快照与 up 前 deepEqual');

  const boundary = await c.query(
    `SELECT
       to_regclass('public.deletion_requests') IS NOT NULL AS table_present,
       to_regclass('public.deletion_requests_receipt_hash_key') IS NOT NULL AS unique_index_present,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'deletion_requests' AND column_name = 'receipt_hash'
       ) AS receipt_hash_present,
       (SELECT count(*)::int FROM pg_constraint
         WHERE conrelid = to_regclass('public.deletion_requests')
           AND conname IN ('deletion_requests_complete_pair', 'deletion_requests_due_order')) AS legacy_constraints`,
  );
  const boundaryRow = boundary.rows[0];
  assert.equal(boundaryRow.table_present, true, 'down 不得删 0003 的 deletion_requests 表');
  assert.equal(boundaryRow.unique_index_present, true, 'down 不得删 0003 的唯一索引');
  assert.equal(boundaryRow.receipt_hash_present, true, 'down 不得删 0003 的既有列');
  assert.equal(boundaryRow.legacy_constraints, 2, 'down 不得删 0003 的两条 CHECK');

  // 既有 down 脚本不回写台账（已知缺口）：台账仍 MIGRATION_COUNT 行，直接 `up` 会跳过 0016。
  assert.equal(
    (await ledgerRows(c)).length,
    MIGRATION_COUNT,
    '既有 down 脚本不回写 schema_migrations（已知缺口）',
  );
  await c.query("DELETE FROM schema_migrations WHERE version = '0016'");
  run = runUp(DB_C);
  assert.equal(run.status, 0, `回滚后重新 \`up\` 必须成功；stderr=${run.stderr}`);
  assert.deepEqual(await snapshot0016(c), afterUp, 'down→up 必须回到与首次 up 完全一致的对象集合');

  await c.query(sqlFile(SQL_0016_DOWN));
  assert.deepEqual(await snapshot0016(c), beforeUp, 'down→up→down 必须回到同一快照（可重复）');
  say('C2 两轮 down→up→down：快照守恒，且 down 不碰 0003 的表/唯一索引/既有列/两条 CHECK');

  console.log(
    `ALL ${passed} migration negative groups passed against native PG${version}; ` +
      "only 0016's up/down pair is exercised, the runner has no down command, and down scripts do not update the ledger.",
  );
} catch (error) {
  bodyFailure = error;
  throw error;
} finally {
  for (const client of opened) await client.end().catch(() => {});
  await maint?.end().catch(() => {});
  // ⚠ 这里**不再** `.catch(() => {})` 吞错：删库失败必须让本步红。
  //   实测（本片 R3）：同一形状 `DROP DATABASE … .catch(() => {})` 在无权限/有依赖时会静默留下库，
  //   进程照绿退出 0；去掉 catch 后同一现场报 `must be owner of database …`。
  const faults = [];
  for (const name of [...DATABASES, MAINT_DATABASE]) {
    try {
      await dropDatabase(name);
    } catch (error) {
      faults.push(`${name}: ${error.message}`);
    }
  }
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  const leftover = await leftoverDatabases();
  const baseObjectsAfter = await publicObjects(admin);
  await admin.end();
  if (bodyFailure) {
    // 正向臂已经红了：不要用收尾断言盖掉原始失败，但把清理故障打出来。
    if (faults.length > 0 || leftover.length > 0) {
      console.error(`[teardown] 另有清理故障：${faults.join('; ')}；残留库：${leftover.join(',') || '(无)'}`);
    }
  } else {
    assert.deepEqual(faults, [], `收尾删库失败（不得吞错）：${faults.join('; ')}`);
    assert.deepEqual(
      leftover,
      [],
      `收尾必须删净以 ${DATABASE_PREFIX} 开头的库，实测残留：${leftover.join(',') || '(无)'}`,
    );
    assert.equal(baseObjectsAfter, baseObjectsBefore, '基准库 public 对象数不得变化（本臂不在基准库建对象）');
  }
}
