import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MIGRATIONS_DIR,
  applyMigrations,
  checksum,
  discoverMigrations,
  planMigrations,
} from '../../services/api/src/db/migrate.ts';

/**
 * 内存替身客户端：只记录查询与维护台账，不对真实数据库执行 SQL。
 * 用于验证运行器的发现/排序/校验和/drift/幂等逻辑（确定性单元）。
 */
function makeFakeClient(initialLedger = []) {
  const ledger = initialLedger.map((row) => ({ ...row }));
  const queries = [];
  return {
    queries,
    ledger,
    async query(text, values) {
      const trimmed = text.trim();
      queries.push({ text: trimmed, values });
      if (trimmed.startsWith('SELECT version, name, checksum')) {
        return { rows: ledger.map((row) => ({ ...row })) };
      }
      if (trimmed.startsWith('INSERT INTO schema_migrations')) {
        ledger.push({ version: values[0], name: values[1], checksum: values[2] });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test('仓库迁移目录至少包含 0001 且校验和为 64 位十六进制', () => {
  const migrations = discoverMigrations(DEFAULT_MIGRATIONS_DIR);
  assert.ok(migrations.length >= 1);
  assert.equal(migrations[0].version, '0001');
  assert.equal(migrations[0].filename, '0001_initial_schema.sql');
  for (const migration of migrations) assert.match(migration.checksum, /^[0-9a-f]{64}$/);
});

test('运行器发现 GY-I03 的 0002 迁移（与 0001 同目录，升序在 0001 之后）', () => {
  const migrations = discoverMigrations(DEFAULT_MIGRATIONS_DIR);
  const versions = migrations.map((m) => m.version);
  assert.ok(versions.includes('0002'), `应发现 0002，实际：${versions.join(',')}`);
  assert.equal(versions.indexOf('0001') < versions.indexOf('0002'), true, '0001 必须排在 0002 之前');
  const m0002 = migrations.find((m) => m.version === '0002');
  assert.equal(m0002.filename, '0002_knowledge_catalog.sql');
  assert.match(m0002.checksum, /^[0-9a-f]{64}$/);
  // down 文件不在运行器目录（否则文件名不合规会抛错）；此处能发现即证明目录只含合规上迁移。
  assert.ok(!migrations.some((m) => m.filename.includes('.down.')), '运行器目录不得含 .down.sql');
});

test('迁移文件按版本号升序，且校验和稳定', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gy-mig-'));
  try {
    writeFileSync(join(dir, '0002_second.sql'), 'SELECT 2;\n');
    writeFileSync(join(dir, '0001_first.sql'), 'SELECT 1;\n');
    const migrations = discoverMigrations(dir);
    assert.deepEqual(migrations.map((m) => m.version), ['0001', '0002']);
    assert.equal(migrations[0].checksum, checksum('SELECT 1;\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重复版本号或非法文件名在应用前被拒绝', () => {
  const dupDir = mkdtempSync(join(tmpdir(), 'gy-mig-dup-'));
  const badDir = mkdtempSync(join(tmpdir(), 'gy-mig-bad-'));
  try {
    writeFileSync(join(dupDir, '0001_a.sql'), 'SELECT 1;\n');
    writeFileSync(join(dupDir, '0001_b.sql'), 'SELECT 1;\n');
    assert.throws(() => discoverMigrations(dupDir), /版本号重复/);

    writeFileSync(join(badDir, 'init.sql'), 'SELECT 1;\n');
    assert.throws(() => discoverMigrations(badDir), /文件名不合规/);
  } finally {
    rmSync(dupDir, { recursive: true, force: true });
    rmSync(badDir, { recursive: true, force: true });
  }
});

test('planMigrations 识别 drift 与待应用集合', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gy-mig-plan-'));
  try {
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1;\n');
    writeFileSync(join(dir, '0002_b.sql'), 'SELECT 2;\n');
    const migrations = discoverMigrations(dir);

    const clean = planMigrations([{ version: '0001', name: 'a', checksum: migrations[0].checksum }], migrations);
    assert.deepEqual(clean.toApply.map((m) => m.version), ['0002']);
    assert.deepEqual(clean.drift, []);

    const drifted = planMigrations([{ version: '0001', name: 'a', checksum: 'f'.repeat(64) }], migrations);
    assert.equal(drifted.drift.length, 1);
    assert.equal(drifted.drift[0].version, '0001');
    assert.deepEqual(drifted.toApply.map((m) => m.version), ['0002']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyMigrations 空台账时应用迁移，重复执行幂等跳过', async () => {
  const migrations = discoverMigrations(DEFAULT_MIGRATIONS_DIR);
  const allVersions = migrations.map((m) => m.version);
  // 容错断言：只要求仓库迁移包含 0001 与 0002；其它 PR 的迁移（如 0003）先后合入都不打破。
  assert.ok(
    allVersions.includes('0001') && allVersions.includes('0002'),
    `仓库迁移应含 0001 与 0002，实际：${allVersions.join(',')}`,
  );
  const client = makeFakeClient();

  const first = await applyMigrations(client, migrations);
  assert.deepEqual(first.applied, allVersions);
  assert.deepEqual(first.skipped, []);
  const began = client.queries.filter((q) => q.text === 'BEGIN');
  const committed = client.queries.filter((q) => q.text === 'COMMIT');
  assert.equal(began.length, allVersions.length, '每个待应用迁移独立事务');
  assert.equal(committed.length, allVersions.length);

  const second = await applyMigrations(client, migrations);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, allVersions);
  assert.equal(client.queries.filter((q) => q.text === 'BEGIN').length, allVersions.length, '第二次不应再执行迁移事务');
});

test('applyMigrations 遇校验和 drift 抛错且不写入新迁移', async () => {
  const migrations = discoverMigrations(DEFAULT_MIGRATIONS_DIR);
  const client = makeFakeClient([{ version: '0001', name: 'initial_schema', checksum: '0'.repeat(64) }]);

  await assert.rejects(() => applyMigrations(client, migrations), /drift/);
  assert.equal(client.ledger.length, 1, 'drift 时不得插入/覆盖台账');
});
