/**
 * GY-R34 · 保留策略（`packages/privacy/retention-policy.mjs`）与执行器
 * （`tools/purge-retention-expired.mjs`）的**纯逻辑**单测：不连库、不读系统时钟。
 *
 * 分层（每层对应派单里的一个硬要求）：
 *   §1 **策略表自洽**：无重复表、天数>0、依据必填（闭集 + 引用出处）、处理方式可执行；
 *      并用**负控制**逐条踩红（改坏一处就必须抛错，否则「永远是绿」的橡皮图章也能过）；
 *   §2 **策略表与迁移同源**：策略引用的表名/列名必须真的在 `services/api/db/migrations/` 里
 *      `CREATE TABLE` 得到（防「策略表写在空气里，执行器一跑就缺表」）；
 *   §3 **dry-run 不写库**：一次性断言整轮只发了 `SELECT`，没有 `BEGIN`/`COMMIT`/`DELETE`/`UPDATE`；
 *   §4 **分批删除正确**：每批 ≤500、批数/行数读数正确、`--max-batches` 用满时如实报「未吃完」；
 *   §5 **重复执行幂等**：第二轮全 0 行，且判据里带着「已处理过就不再匹配」的条件；
 *   §6 cutoff 边界与严格的 ISO-8601（裸本地时间拒绝）；
 *   §7 参数归一化（`--batch 501` / `0` / `1.5` 一律拒绝，不静默截断）；
 *   §8 失败分类与退出码（权限/缺表/审计不可变/未知 SQLSTATE；0/1/2）。
 *
 * 真库臂在 `tests/integration/retention-purge-pg.mjs`（未取得 PG 二进制 ⇒ 77 跳过）。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RETENTION_BATCH_LIMIT,
  MAX_RETENTION_BATCH_LIMIT,
  MAX_RETENTION_MAX_BATCHES,
  RETENTION_BASES,
  RETENTION_DISPOSITIONS,
  RETENTION_EXCLUSIONS,
  RETENTION_POLICY,
  RETENTION_POLICY_ERROR_CODES,
  RETENTION_POLICY_ID,
  assertRetentionPolicy,
  buildRetentionCountSql,
  buildRetentionMutationSql,
  normalizeRetentionBatchLimit,
  normalizeRetentionMaxBatches,
  retentionCutoffIso,
  retentionDuePredicate,
} from '../../packages/privacy/retention-policy.mjs';
import {
  RETENTION_PURGE_EXIT,
  RETENTION_PURGE_FAILURES,
  classifyRetentionFailure,
  formatRetentionPurgeReport,
  main,
  retentionPurgeExitCode,
  runRetentionPurge,
} from '../../tools/purge-retention-expired.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = join(repoRoot, 'services', 'api', 'db', 'migrations');

/** 固定时刻：所有读数都由它推导，不受跑测试的墙钟影响。 */
const NOW = '2026-10-23T00:00:00.000Z';

/**
 * 造一个记录全部语句的假连接（`query(text, params)` 形状与 pg 的 client 一致）。
 *
 * @param {{ due?: number[], rowCounts?: Array<number | 'throw'>, throwOn?: RegExp }} input
 */
function createFakeConnection({ due = [], rowCounts = [], throwOn = null } = {}) {
  const statements = [];
  const queueDue = [...due];
  const queueRows = [...rowCounts];
  let releases = 0;
  const client = {
    async query(text, params = []) {
      statements.push({ text, params: [...params] });
      if (throwOn !== null && throwOn.test(text)) {
        throw Object.assign(new Error('boom（测试夹具：故意失败）'), { code: '42501' });
      }
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(text)) return { rowCount: null, rows: [] };
      if (/count\(\*\)/i.test(text)) {
        return { rows: [{ due: String(queueDue.length > 0 ? queueDue.shift() : 0) }], rowCount: 1 };
      }
      const next = queueRows.length > 0 ? queueRows.shift() : 0;
      if (next === 'throw') throw Object.assign(new Error('boom（测试夹具：故意失败）'), { code: '42501' });
      return { rowCount: next, rows: [] };
    },
    release() {
      // 归还连接是 pg 的客户端行为，不是 SQL；单独计数，别混进语句流水里。
      releases += 1;
    },
  };
  return { client, statements, get releases() { return releases; }, connect: async () => client };
}

const mutateStatements = (statements) =>
  statements.filter((s) => /^\s*(DELETE|UPDATE)\b/i.test(s.text));
const txStatements = (statements) =>
  statements.filter((s) => /^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(s.text));

// ---------------------------------------------------------------------------
// §1 策略表自洽（正臂 + 负控制）
// ---------------------------------------------------------------------------
test('§1 仓内策略表自洽：4 张表、三种处理方式、无重复表、天数>0、依据必填', () => {
  assert.equal(RETENTION_POLICY_ID, 'GY-R34-RETENTION');
  assert.doesNotThrow(() => assertRetentionPolicy(RETENTION_POLICY));
  assert.equal(RETENTION_POLICY.length, 4);

  const tables = RETENTION_POLICY.map((entry) => entry.table);
  assert.equal(new Set(tables).size, tables.length, '策略表不得重复登记同一张表');
  assert.deepEqual(tables, [
    'public.idempotency_keys',
    'public.sessions',
    'public.admin_sessions',
    'public.community_reports',
  ]);

  // 三种处理方式都必须真的被用到（否则「支持三种」只是纸面能力）。
  const dispositions = new Set(RETENTION_POLICY.map((entry) => entry.disposition));
  assert.deepEqual([...dispositions].sort(), [...RETENTION_DISPOSITIONS].sort());

  for (const entry of RETENTION_POLICY) {
    assert.ok(Number.isInteger(entry.retentionDays) && entry.retentionDays > 0, `${entry.table} 天数必须 >0`);
    assert.ok(RETENTION_BASES.includes(entry.basis), `${entry.table} 依据必须在闭集内`);
    assert.ok(entry.basisRef.length > 0, `${entry.table} 依据必须引用出处`);
    assert.ok(entry.why.length > 20, `${entry.table} 必须写明为什么是这个天数`);
    assert.equal(entry.idempotent, true);
    // schema 必须写全（裸表名会让 search_path 决定打到哪个 schema）。
    assert.match(entry.table, /^public\.[a-z_]+$/);
  }

  // 依据要覆盖三档（法务 / 产品 / 审计留存），否则策略表只覆盖了一半场景。
  assert.deepEqual([...new Set(RETENTION_POLICY.map((entry) => entry.basis))].sort(), ['audit', 'legal', 'product']);
});

test('§1 负控制：改坏一处就必须抛错（否则策略表校验是橡皮图章）', () => {
  const base = RETENTION_POLICY[0];

  const cases = [
    ['重复表', [{ ...base }, { ...RETENTION_POLICY[1], table: base.table }], RETENTION_POLICY_ERROR_CODES.TABLE_DUPLICATE],
    ['天数 0', [{ ...base, retentionDays: 0 }], RETENTION_POLICY_ERROR_CODES.DAYS],
    ['天数小数', [{ ...base, retentionDays: 1.5 }], RETENTION_POLICY_ERROR_CODES.DAYS],
    ['天数负数', [{ ...base, retentionDays: -30 }], RETENTION_POLICY_ERROR_CODES.DAYS],
    ['天数缺失', [{ ...base, retentionDays: undefined }], RETENTION_POLICY_ERROR_CODES.DAYS],
    ['依据越界', [{ ...base, basis: 'because-we-said-so' }], RETENTION_POLICY_ERROR_CODES.BASIS],
    ['依据缺失', [{ ...base, basisRef: '   ' }], RETENTION_POLICY_ERROR_CODES.BASIS_REF],
    ['处理方式越界', [{ ...base, disposition: 'truncate' }], RETENTION_POLICY_ERROR_CODES.DISPOSITION],
    ['裸表名', [{ ...base, table: 'sessions' }], RETENTION_POLICY_ERROR_CODES.TABLE_NAME],
    ['表名带注入', [{ ...base, table: 'public.sessions; DROP TABLE users' }], RETENTION_POLICY_ERROR_CODES.TABLE_NAME],
    ['delete 带目标列', [{ ...base, targetColumn: 'revoked_at' }], RETENTION_POLICY_ERROR_CODES.TARGET_COLUMN],
    ['anonymize 缺目标列', [{ ...base, disposition: 'anonymize' }], RETENTION_POLICY_ERROR_CODES.TARGET_COLUMN],
    ['archive_marker 缺 markerSource', [{ ...base, disposition: 'archive_marker', targetColumn: 'revoked_at' }], RETENTION_POLICY_ERROR_CODES.MARKER_SOURCE],
    ['delete 带 markerSource', [{ ...base, markerSource: 'age_column' }], RETENTION_POLICY_ERROR_CODES.MARKER_SOURCE],
    ['缺 why', [{ ...base, why: '' }], RETENTION_POLICY_ERROR_CODES.WHY],
    ['幂等未声明', [{ ...base, idempotent: false }], RETENTION_POLICY_ERROR_CODES.IDEMPOTENCE],
    ['空表', [], RETENTION_POLICY_ERROR_CODES.NOT_ARRAY],
    ['不是数组', { rows: [] }, RETENTION_POLICY_ERROR_CODES.NOT_ARRAY],
  ];

  for (const [label, policy, expectedCode] of cases) {
    assert.throws(
      () => assertRetentionPolicy(policy),
      (error) => error.code === expectedCode,
      `负控制「${label}」必须抛 ${expectedCode}`,
    );
  }
});

test('§1 被排除的表必须写明理由（「没写」不等于「不做」）', () => {
  assert.ok(RETENTION_EXCLUSIONS.length >= 5);
  const excluded = RETENTION_EXCLUSIONS.map((row) => row.table).join(' ');
  // 审计表是 append-only：策略表不得登记它（详见迁移 0017 的 AUDIT_IMMUTABLE 触发器）。
  assert.match(excluded, /public\.admin_audit_events/);
  for (const row of RETENTION_EXCLUSIONS) {
    assert.ok(row.reason.length > 20, `${row.table} 必须给出排除理由`);
  }
  const policyTables = new Set(RETENTION_POLICY.map((entry) => entry.table));
  for (const entry of RETENTION_POLICY) {
    assert.ok(!excluded.split(' ').includes(entry.table), `${entry.table} 不能既登记又排除`);
  }
  for (const table of ['public.admin_audit_events', 'public.media_object_cleanup', 'public.user_backup_copies']) {
    assert.ok(!policyTables.has(table), `${table} 不应出现在可执行策略里`);
  }
});

// ---------------------------------------------------------------------------
// §2 策略表与迁移同源（表名/列名必须真的存在）
// ---------------------------------------------------------------------------
test('§2 策略引用的表与列都能在 migrations 里 CREATE TABLE 得到', () => {
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  const creates = new Map();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const pattern = /CREATE TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/g;
    let match = pattern.exec(sql);
    while (match !== null) {
      const end = sql.indexOf('\n);', match.index);
      assert.ok(end > 0, `${file} 里 ${match[1]} 的 CREATE TABLE 没有结束括号`);
      creates.set(match[1], { file, block: sql.slice(match.index, end) });
      match = pattern.exec(sql);
    }
  }

  for (const entry of RETENTION_POLICY) {
    const [, bareName] = entry.table.split('.');
    const found = creates.get(bareName);
    assert.ok(found !== undefined, `${entry.table} 在 migrations 里找不到 CREATE TABLE`);
    for (const column of [entry.ageColumn, entry.targetColumn]) {
      if (column === null || column === undefined) continue;
      assert.match(
        found.block,
        new RegExp(`(^|\\s)${column}\\s`, 'm'),
        `${entry.table}.${column} 不在 ${found.file} 的建表语句里`,
      );
    }
  }

  // 反向自证：审计表的 append-only 触发器真的存在（策略表据此排除它，不是随口说的）。
  const auditSql = readFileSync(join(migrationsDir, '0017_account_suspend_authority.sql'), 'utf8');
  assert.match(auditSql, /BEFORE UPDATE OR DELETE ON public\.admin_audit_events/);
  assert.match(auditSql, /'AUDIT_IMMUTABLE'/);
});

// ---------------------------------------------------------------------------
// §3 dry-run 不写库
// ---------------------------------------------------------------------------
test('§3 dry-run（默认）只发 SELECT：没有 BEGIN/COMMIT，也没有任何 DELETE/UPDATE', async () => {
  const { client, statements, connect } = createFakeConnection({ due: [3, 7, 2, 5] });
  const lines = [];
  const report = await runRetentionPurge({
    connect,
    now: NOW,
    // 不传 dryRun：默认就是 dry-run（手滑不会删数据）。
    log: (line) => lines.push(line),
  });

  assert.equal(report.dry_run, true);
  assert.equal(mutateStatements(statements).length, 0, 'dry-run 一次都不许发变更语句');
  assert.equal(txStatements(statements).length, 0, 'dry-run 不许开事务');
  for (const statement of statements) {
    assert.match(statement.text, /^\s*SELECT\s/i, `dry-run 发了一条非 SELECT：${statement.text}`);
  }

  assert.deepEqual(
    report.entries.map((entry) => entry.rows),
    [3, 7, 2, 5],
  );
  assert.equal(report.totals.rows, 17);
  assert.equal(report.totals.batches, 0);
  assert.equal(report.totals.failures, 0);
  assert.equal(report.totals.drained, 4);
  assert.ok(lines.some((line) => /dry-run/.test(line)));
  // 报告文本不得泄露连接串/口令。
  for (const line of formatRetentionPurgeReport(report)) {
    assert.doesNotMatch(line, /postgres(ql)?:\/\//);
  }
});

// ---------------------------------------------------------------------------
// §4 分批删除正确
// ---------------------------------------------------------------------------
test('§4 分批：500+500+123 三批吃完，每批 ≤500 且各自 BEGIN/COMMIT', async () => {
  const { client, statements, connect } = createFakeConnection({ rowCounts: [500, 500, 123] });
  const report = await runRetentionPurge({
    connect,
    now: NOW,
    dryRun: false,
    onlyTables: ['public.idempotency_keys'],
  });

  const entry = report.entries[0];
  assert.equal(entry.table, 'public.idempotency_keys');
  assert.equal(entry.batches, 3);
  assert.equal(entry.rows, 1123);
  assert.equal(entry.drained, true);
  assert.equal(entry.error, null);
  assert.equal(report.totals.rows, 1123);
  assert.equal(report.totals.batches, 3);

  const mutations = mutateStatements(statements);
  assert.equal(mutations.length, 3);
  for (const statement of mutations) {
    assert.equal(statement.params[1], MAX_RETENTION_BATCH_LIMIT, 'LIMIT 必须是单批上限 500');
    assert.match(statement.text, /LIMIT \$2/);
    assert.match(statement.text, /WHERE "expires_at" < \$1/);
  }
  // 每批一个事务：BEGIN/COMMIT 成对出现（3 批 = 3 对）。
  assert.equal(txStatements(statements).filter((s) => /BEGIN/i.test(s.text)).length, 3);
  assert.equal(txStatements(statements).filter((s) => /COMMIT/i.test(s.text)).length, 3);
  assert.equal(client.release !== undefined, true);
});

test('§4 --batch 200 生效；--max-batches 用满时如实报「未吃完」而不是谎称清完', async () => {
  const { statements, connect } = createFakeConnection({ rowCounts: [200, 200] });
  const report = await runRetentionPurge({
    connect,
    now: NOW,
    dryRun: false,
    batchLimit: 200,
    maxBatches: 2,
    onlyTables: ['public.sessions'],
  });

  const entry = report.entries[0];
  assert.equal(entry.batches, 2);
  assert.equal(entry.rows, 400);
  assert.equal(entry.drained, false, '用满 max-batches 仍每批满 → 不许标记为已吃完');
  assert.equal(report.totals.drained, 0);
  for (const statement of mutateStatements(statements)) {
    assert.equal(statement.params[1], 200);
  }
});

test('§4 单表失败只记该表失败码，后续表照跑（失败不阻塞、可重入）', async () => {
  const due = [1, 2, 3, 4];
  const statements = [];
  const client = {
    async query(text, params = []) {
      statements.push({ text, params: [...params] });
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(text)) return { rowCount: null, rows: [] };
      if (/count\(\*\)/i.test(text)) return { rows: [{ due: String(due.shift() ?? 0) }], rowCount: 1 };
      if (/UPDATE "public"\."sessions"/.test(text) === false && /public"\."sessions/.test(text)) {
        throw Object.assign(new Error('permission denied'), { code: '42501' });
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };

  const report = await runRetentionPurge({ connect: async () => client, now: NOW, dryRun: true });
  // dry-run 不触发变更语句：这里改用真执行验证失败分类。
  assert.equal(report.totals.failures, 0);

  const failing = {
    async query(text, params = []) {
      statements.push({ text, params: [...params] });
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(text)) return { rowCount: null, rows: [] };
      if (/public"\."sessions/.test(text)) {
        throw Object.assign(new Error('permission denied'), { code: '42501' });
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const executed = await runRetentionPurge({ connect: async () => failing, now: NOW, dryRun: false });
  assert.equal(executed.totals.failures, 1);
  assert.equal(executed.entries[1].error, RETENTION_PURGE_FAILURES.PERMISSION_DENIED);
  assert.equal(executed.entries[0].error, null, '前一张表不受影响');
  assert.equal(executed.entries[2].error, null, '后一张表照跑（失败不阻塞）');
  assert.equal(retentionPurgeExitCode(executed), RETENTION_PURGE_EXIT.FAILED);
  assert.match(formatRetentionPurgeReport(executed).join('\n'), /FAIL PERMISSION_DENIED/);
});

// ---------------------------------------------------------------------------
// §5 重复执行幂等
// ---------------------------------------------------------------------------
test('§5 重复执行第二次全 0 行（判据里带「已处理过就不再匹配」的条件）', async () => {
  const first = createFakeConnection({ rowCounts: [500, 12] });
  const run1 = await runRetentionPurge({
    connect: first.connect,
    now: NOW,
    dryRun: false,
    onlyTables: ['public.community_reports'],
  });
  assert.equal(run1.entries[0].rows, 512);

  const second = createFakeConnection({ rowCounts: [0] });
  const run2 = await runRetentionPurge({
    connect: second.connect,
    now: NOW,
    dryRun: false,
    onlyTables: ['public.community_reports'],
  });
  assert.equal(run2.totals.rows, 0, '第二次执行必须 0 行');
  assert.equal(run2.entries[0].rows, 0);
  assert.equal(run2.entries[0].drained, true);
  assert.equal(retentionPurgeExitCode(run2), RETENTION_PURGE_EXIT.OK, '0 行不是失败（cron 判据）');

  // 幂等靠的是判据本身：匿名化只碰「还没被处理过」的行，标记只碰「还没标记」的行。
  const anonymizeSql = buildRetentionMutationSql(RETENTION_POLICY[3]);
  assert.match(anonymizeSql, /AND "detail" IS NOT NULL/);
  assert.match(anonymizeSql, /SET "detail" = NULL/);
  const markerSql = buildRetentionMutationSql(RETENTION_POLICY[2]);
  assert.match(markerSql, /AND "revoked_at" IS NULL/);
  assert.match(markerSql, /SET "revoked_at" = "expires_at"/, '标记值来自行内年龄列，不读时钟');
  // delete 的判据里没有任何「目标列」条件（行已被删掉，天然不再匹配）。
  assert.doesNotMatch(buildRetentionMutationSql(RETENTION_POLICY[0]), /IS (NOT )?NULL/);
});

test('§5 三种处理方式的 SQL 形状各不相同（delete / anonymize / archive_marker）', () => {
  const [del, , marker, anonymize] = RETENTION_POLICY;
  assert.match(buildRetentionMutationSql(del), /^DELETE FROM "public"\."idempotency_keys" WHERE ctid IN \(SELECT ctid/);
  assert.match(buildRetentionMutationSql(anonymize), /^UPDATE "public"\."community_reports" SET "detail" = NULL WHERE ctid IN/);
  assert.match(buildRetentionMutationSql(marker), /^UPDATE "public"\."admin_sessions" SET "revoked_at" = "expires_at" WHERE ctid IN/);
  for (const entry of RETENTION_POLICY) {
    assert.match(buildRetentionCountSql(entry), /^SELECT count\(\*\)::bigint AS due FROM /);
    // 计数与变更必须共用同一个判据（否则 dry-run 的读数对不上真跑）。
    assert.ok(buildRetentionMutationSql(entry).includes(retentionDuePredicate(entry).replace(/^"public"\."([a-z_]+)" /, '')));
  }
});

// ---------------------------------------------------------------------------
// §6 cutoff 边界
// ---------------------------------------------------------------------------
test('§6 cutoff = now − N×24h，闭区间语义（年龄 ≥ N 天即到期）', () => {
  assert.equal(retentionCutoffIso({ now: NOW, retentionDays: 1 }), '2026-10-22T00:00:00.000Z');
  assert.equal(retentionCutoffIso({ now: NOW, retentionDays: 30 }), '2026-09-23T00:00:00.000Z');
  assert.equal(retentionCutoffIso({ now: NOW, retentionDays: 365 }), '2025-10-23T00:00:00.000Z');
  assert.equal(
    retentionCutoffIso({ now: '2026-10-23T08:00:00+08:00', retentionDays: 7 }),
    '2026-10-16T00:00:00.000Z',
  );
  assert.throws(() => retentionCutoffIso({ now: '2026-10-23T00:00:00', retentionDays: 7 }), TypeError, '裸本地时间必须拒绝');
  assert.throws(() => retentionCutoffIso({ now: NOW, retentionDays: 0 }), TypeError);
  assert.throws(() => retentionCutoffIso({ now: NOW, retentionDays: 2.5 }), TypeError);
  assert.throws(() => retentionCutoffIso({ now: 'not-a-time', retentionDays: 7 }), TypeError);
});

// ---------------------------------------------------------------------------
// §7 参数归一化
// ---------------------------------------------------------------------------
test('§7 批大小/批数硬顶：越界即抛，不静默截断', () => {
  assert.equal(normalizeRetentionBatchLimit(1), 1);
  assert.equal(normalizeRetentionBatchLimit(500), 500);
  assert.equal(normalizeRetentionBatchLimit(DEFAULT_RETENTION_BATCH_LIMIT), MAX_RETENTION_BATCH_LIMIT);
  for (const bad of [0, 501, 5000, 1.5, -1, '500', null, undefined]) {
    assert.throws(() => normalizeRetentionBatchLimit(bad), RangeError, `--batch ${String(bad)} 必须拒绝`);
  }
  assert.equal(normalizeRetentionMaxBatches(1), 1);
  assert.equal(normalizeRetentionMaxBatches(MAX_RETENTION_MAX_BATCHES), MAX_RETENTION_MAX_BATCHES);
  for (const bad of [0, MAX_RETENTION_MAX_BATCHES + 1, 2.5, '3', null]) {
    assert.throws(() => normalizeRetentionMaxBatches(bad), RangeError);
  }
  assert.throws(
    () => buildRetentionMutationSql({ table: 'public.users; DROP TABLE users', ageColumn: 'x', disposition: 'delete' }),
    (error) => error.code === RETENTION_POLICY_ERROR_CODES.TABLE_NAME,
    '拼 SQL 前必须再挡一次非法表名',
  );
});

// ---------------------------------------------------------------------------
// §8 失败分类与退出码
// ---------------------------------------------------------------------------
test('§8 失败码映射与退出码（0/1/2）', () => {
  assert.equal(classifyRetentionFailure({ code: '42501' }), RETENTION_PURGE_FAILURES.PERMISSION_DENIED);
  assert.equal(classifyRetentionFailure({ code: '42P01' }), RETENTION_PURGE_FAILURES.MISSING_TABLE);
  assert.equal(classifyRetentionFailure({ code: '42703' }), RETENTION_PURGE_FAILURES.MISSING_COLUMN);
  assert.equal(classifyRetentionFailure({ code: 'G0006' }), RETENTION_PURGE_FAILURES.AUDIT_IMMUTABLE);
  assert.equal(classifyRetentionFailure({ code: 'ECONNREFUSED' }), RETENTION_PURGE_FAILURES.CONNECTION_FAILED);
  assert.equal(classifyRetentionFailure({ code: 'XX000' }), RETENTION_PURGE_FAILURES.UNCLASSIFIED);
  assert.equal(classifyRetentionFailure(null), RETENTION_PURGE_FAILURES.UNCLASSIFIED);

  assert.equal(retentionPurgeExitCode({ totals: { failures: 0 } }), 0);
  assert.equal(retentionPurgeExitCode({ totals: { failures: 2 } }), 1);
});

test('§8 CLI 参数闸门：--dry-run 与 --yes 互斥、缺 DATABASE_URL、--batch 越界都返回 2', async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  console.error = (line) => lines.push(String(line));
  const saved = process.env.DATABASE_URL;
  try {
    delete process.env.DATABASE_URL;

    assert.equal(await main(['--dry-run', '--yes']), RETENTION_PURGE_EXIT.CONFIG);
    assert.match(lines.join('\n'), /不能同时给/);

    lines.length = 0;
    assert.equal(await main(['--batch', '501']), RETENTION_PURGE_EXIT.CONFIG);
    assert.match(lines.join('\n'), /批大小必须是 1\.\.500/);

    lines.length = 0;
    assert.equal(await main(['--batch', 'abc']), RETENTION_PURGE_EXIT.CONFIG);
    assert.match(lines.join('\n'), /十进制正整数/);

    lines.length = 0;
    assert.equal(await main(['--table', 'public.users']), RETENTION_PURGE_EXIT.CONFIG);
    assert.match(lines.join('\n'), /不在保留策略表里/);

    lines.length = 0;
    assert.equal(await main([]), RETENTION_PURGE_EXIT.CONFIG);
    assert.match(lines.join('\n'), /缺少 DATABASE_URL/);

    lines.length = 0;
    assert.equal(await main(['--help']), RETENTION_PURGE_EXIT.OK);
    assert.match(lines.join('\n'), /默认 --dry-run/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

test('§8 真执行入口在拿到假连接时也读同一条策略（不硬编码表名）', async () => {
  // 自定义策略：只要一张表，验证执行器的表清单完全来自入参 policy。
  const policy = [
    {
      ...RETENTION_POLICY[0],
      table: 'public.idempotency_keys',
      retentionDays: 2,
    },
  ];
  const { statements, connect } = createFakeConnection({ rowCounts: [1] });
  const report = await runRetentionPurge({ connect, now: NOW, dryRun: false, policy });
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].retention_days, 2);
  assert.equal(report.entries[0].cutoff, '2026-10-21T00:00:00.000Z');
  assert.equal(report.totals.rows, 1);
  assert.match(mutateStatements(statements)[0].text, /"public"\."idempotency_keys"/);
});
