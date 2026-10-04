/**
 * 数据库迁移运行器。
 *
 * - 迁移文件：services/api/db/migrations/NNNN_name.sql（NNNN 为四位版本号，升序执行）。
 * - 版本台账：schema_migrations(version, name, checksum, applied_at)。
 * - 已应用迁移的校验和变化即 drift，拒绝继续（不静默覆盖）。
 * - 重复版本号拒绝（在应用前失败）。
 * - 无 DATABASE_URL 时明确失败，不假装迁移成功。
 *
 * 说明：本机无 PostgreSQL 服务，迁移只做了发现/排序/校验和/计划逻辑的确定性测试，
 * 未对真实数据库执行（见 docs/engineering-shell.md）。
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
