/**
 * 数据库迁移运行器。
 *
 * - 迁移文件：services/api/db/migrations/NNNN_name.sql（NNNN 为四位版本号，升序执行）。
 * - 版本台账：schema_migrations(version, name, checksum, applied_at)。
 * - 已应用迁移的校验和变化即 drift，拒绝继续（不静默覆盖）。
 * - 重复版本号拒绝（在应用前失败）。
 * - 无 DATABASE_URL 时明确失败，不假装迁移成功。
 *
 * 骨架最初只做确定性测试；0001/0002/0005 的隔离 PostgreSQL 17.11
 * 执行证据见 docs/verification/gy-i25-catalog-pg.md，不代表生产库已接入。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
}

export interface MigrationPlan {
  toApply: MigrationFile[];
  alreadyApplied: MigrationFile[];
  drift: Array<{ version: string; expected: string; applied: string }>;
}

export interface MigrationClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

const MIGRATION_PATTERN = /^(\d{4,})_([a-z0-9_]+)\.sql$/;

export function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/** 读取并按版本升序返回迁移文件；文件名不合规或版本重复时抛错。 */
export function discoverMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  const migrations: MigrationFile[] = [];
  const seen = new Map<string, string>();

  for (const filename of entries) {
    const match = MIGRATION_PATTERN.exec(filename);
    if (match === null) {
      throw new Error(`迁移文件名不合规（应为 NNNN_name.sql）：${filename}`);
    }
    const version = match[1];
    const name = match[2];
    if (version === undefined || name === undefined) {
      throw new Error(`迁移文件名解析失败：${filename}`);
    }
    const previous = seen.get(version);
    if (previous !== undefined) {
      throw new Error(`迁移版本号重复：${version} 同时出现在 ${previous} 与 ${filename}`);
    }
    seen.set(version, filename);
    const sql = readFileSync(join(dir, filename), 'utf8');
    migrations.push({ version, name, filename, sql, checksum: checksum(sql) });
  }

  return migrations.sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * 迁移号保留台账的一项：**有意缺号**——该版本号的迁移在另一条在飞分支上，本分支不该也带上它
 * （会撞号），于是 `1..max` 上出现一个真实存在的「洞」。
 *
 * 为什么必须在产品代码里有一个可判定的定义，而不是只在文档里写一句：缺号在「已发现集合」上与
 * 「发现器静默漏项」**完全同形**，靠序号序列本身判不出来。真库臂与 `migrations-negative-pg.mjs`
 * 各有一条「1..max 连续无缺号」的不变量，它们唯一的价值就是抓漏项；台账把「有意缺号」变成
 * 机器事实，让那两条不变量在「本片 0028 先合、0027 在 #428」时仍然可判：
 *   · 只放行**登记过**的缺号，未登记缺号照旧判红；
 *   · `count + reserved === max` 让「登记」不能拿来掩盖漏片；
 *   · 登记过的号一旦在目录里出现（上游合入）⇒ `reservedButPresent` 非空 ⇒ 判红，强制删条目。
 */
export interface MigrationReservation {
  version: number;
  filename: string;
  owner: string;
  reason: string;
  remove_when: string;
}

/** 保留台账文件的默认位置：`services/api/db/migration-reservations.json`（与 migrations 同目录）。 */
export const DEFAULT_RESERVATIONS_FILE = fileURLToPath(
  new URL('../../db/migration-reservations.json', import.meta.url),
);

/** 迁移编号体检结果（① 缺号、② 总数、③ 保留项不许躺平，三件事一次算清）。 */
export interface MigrationNumbering {
  /** 实际发现的迁移数。 */
  count: number;
  /** 发现到的最大版本号。 */
  maxVersion: number;
  /** `1..maxVersion` 里不存在的号（升序）。 */
  gaps: number[];
  /** 台账声明的保留号（升序）。 */
  reserved: number[];
  /** 缺号里**没有**在台账声明的（必须为空：非空 ⇒ 发现器静默漏项）。 */
  undeclaredGaps: number[];
  /** 台账声明过、但文件已经存在（必须为空：非空 ⇒ 条目该删了）。 */
  reservedButPresent: number[];
  /** `count + 已声明保留数 === maxVersion`。 */
  countMatchesMax: boolean;
}

/** 读保留台账并校验形状（缺字段/重复/非法版本号一律抛错，⛔ 不静默当成空表）。 */
export function loadMigrationReservations(file: string = DEFAULT_RESERVATIONS_FILE): MigrationReservation[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { reservations?: unknown };
  if (!Array.isArray(raw.reservations)) {
    throw new Error(`保留台账缺少 reservations 数组：${file}`);
  }
  const seen = new Set<number>();
  return raw.reservations.map((entry) => {
    const item = entry as Partial<MigrationReservation>;
    if (!Number.isInteger(item.version) || (item.version as number) <= 0) {
      throw new Error(`保留台账 version 必须是正整数：${JSON.stringify(entry)}`);
    }
    for (const field of ['filename', 'owner', 'reason', 'remove_when'] as const) {
      const value = item[field];
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`保留台账 ${String(item.version)} 缺 ${field}`);
      }
    }
    if (seen.has(item.version as number)) {
      throw new Error(`保留台账重复登记版本号：${String(item.version)}`);
    }
    seen.add(item.version as number);
    return item as MigrationReservation;
  });
}

/** 体检迁移编号：把「有意缺号」与「发现器漏项」分开判（判据见 {@link MigrationReservation} 注释）。 */
export function inspectMigrationNumbering(
  migrations: MigrationFile[] = discoverMigrations(),
  reservations: MigrationReservation[] = loadMigrationReservations(),
): MigrationNumbering {
  const present = new Set(migrations.map((migration) => Number(migration.version)));
  const reserved = new Set(reservations.map((reservation) => reservation.version));
  const maxVersion = present.size === 0 ? 0 : Math.max(...present);
  const gaps: number[] = [];
  for (let version = 1; version <= maxVersion; version += 1) {
    if (!present.has(version)) gaps.push(version);
  }
  const reservedButPresent = [...reserved].filter((version) => present.has(version)).sort((a, b) => a - b);
  return {
    count: migrations.length,
    maxVersion,
    gaps,
    reserved: [...reserved].sort((a, b) => a - b),
    undeclaredGaps: gaps.filter((version) => !reserved.has(version)),
    reservedButPresent,
    countMatchesMax: migrations.length + reserved.size === maxVersion,
  };
}

/** 版本号按 `NNNN` 补齐（`[M0]` 一类读数用）。 */
export function formatMigrationVersion(version: number): string {
  return String(version).padStart(4, '0');
}

/** 比对台账与磁盘文件，得出待应用列表与 drift。 */
export function planMigrations(applied: AppliedMigration[], migrations: MigrationFile[]): MigrationPlan {
  const appliedByVersion = new Map(applied.map((item) => [item.version, item]));
  const toApply: MigrationFile[] = [];
  const alreadyApplied: MigrationFile[] = [];
  const drift: MigrationPlan['drift'] = [];

  for (const migration of migrations) {
    const record = appliedByVersion.get(migration.version);
    if (record === undefined) {
      toApply.push(migration);
      continue;
    }
    if (record.checksum !== migration.checksum) {
      drift.push({ version: migration.version, expected: migration.checksum, applied: record.checksum });
      continue;
    }
    alreadyApplied.push(migration);
  }

  return { toApply, alreadyApplied, drift };
}

async function ensureLedger(client: MigrationClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version     text PRIMARY KEY,
       name        text NOT NULL,
       checksum    char(64) NOT NULL,
       applied_at  timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

async function loadApplied(client: MigrationClient): Promise<AppliedMigration[]> {
  const result = await client.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  return result.rows.map((row) => ({
    version: String(row.version),
    name: String(row.name),
    checksum: String(row.checksum),
  }));
}

export interface ApplyResult {
  applied: string[];
  skipped: string[];
}

/** 应用待执行迁移。每个迁移在独立事务中执行；drift 或重复版本在写入前失败。 */
export async function applyMigrations(
  client: MigrationClient,
  migrations: MigrationFile[] = discoverMigrations(),
): Promise<ApplyResult> {
  await ensureLedger(client);
  // 串行化并发迁移进程，避免两个进程同时建表。
  await client.query('SELECT pg_advisory_lock(767149023178247)');

  try {
    const applied = await loadApplied(client);
    const plan = planMigrations(applied, migrations);

    if (plan.drift.length > 0) {
      const detail = plan.drift.map((d) => `${d.version}(磁盘 ${d.expected} != 台账 ${d.applied})`).join('; ');
      throw new Error(`迁移校验和 drift，拒绝继续：${detail}`);
    }

    const appliedNow: string[] = [];
    for (const migration of plan.toApply) {
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`迁移 ${migration.filename} 执行失败：${(error as Error).message}`);
      }
      appliedNow.push(migration.version);
    }

    return { applied: appliedNow, skipped: plan.alreadyApplied.map((m) => m.version) };
  } finally {
    await client.query('SELECT pg_advisory_unlock(767149023178247)');
  }
}

export async function migrationStatus(client: MigrationClient, migrations: MigrationFile[] = discoverMigrations()): Promise<MigrationPlan> {
  await ensureLedger(client);
  const applied = await loadApplied(client);
  return planMigrations(applied, migrations);
}

/** 生成符合 pg 连接的客户端；无 DATABASE_URL 时抛错（不假装可用）。 */
async function connectFromEnv(): Promise<{ client: MigrationClient; close: () => Promise<void> }> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('缺少 DATABASE_URL：迁移需要真实数据库连接串，未配置时拒绝运行。');
  }
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  return { client, close: () => client.end() };
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const migrations = discoverMigrations();
  console.log(`发现 ${migrations.length} 个迁移：${migrations.map((m) => m.filename).join(', ')}`);

  if (command === 'list') {
    return;
  }

  const { client, close } = await connectFromEnv();
  try {
    if (command === 'up') {
      const result = await applyMigrations(client, migrations);
      console.log(`已应用：${result.applied.length === 0 ? '（无）' : result.applied.join(', ')}`);
      console.log(`已存在跳过：${result.skipped.length === 0 ? '（无）' : result.skipped.join(', ')}`);
    } else if (command === 'status') {
      const plan = await migrationStatus(client, migrations);
      console.log(`待应用：${plan.toApply.map((m) => m.version).join(', ') || '（无）'}`);
      console.log(`已应用：${plan.alreadyApplied.map((m) => m.version).join(', ') || '（无）'}`);
      if (plan.drift.length > 0) {
        console.log(`drift：${plan.drift.map((d) => d.version).join(', ')}`);
      }
    } else {
      throw new Error(`未知命令：${command}（支持 up | status | list）`);
    }
  } finally {
    await close();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error('迁移失败：', (error as Error).message);
    process.exitCode = 1;
  });
}
