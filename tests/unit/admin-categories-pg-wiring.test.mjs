/**
 * 后台分类字典（`listAdminCategories` / `editCategory`）的**接线证据**（R68）。
 *
 * 本片之前的真实状态：这两个 operation 在 `services/api/src/admin/ops/accounts-only.ts`
 * 里是两条**字面裸 `reject`** —— `adminRealUnwired`（`execution_mode === 'real'`）时无论
 * 有没有库，一律 503。拆掉裸 reject 只会得到**空页**，而两份契约 description 都明写
 * 「⛔ 不返回空页（空页会被读成「平台没有分类」，那是伪造读数）」⇒ 读面必须真的读库。
 *
 * 本文件钉住四件事，逐一对应一条禁止项：
 * 1. `real` + **有池** ⇒ 读面 200 且 SQL 真打到 `public.admin_categories`（不是内存、不是空页）：
 *    断言语句文本与参数，避免"看起来接线了，其实查的是别的表"；
 * 2. 写面 CAS：`UPDATE … SET name = $3, description = $4, active = $5, revision = revision + 1
 *    … WHERE id = $1 AND revision = $2` ⇒ 断言**参数顺序**与 `AND revision = $2` 的存在
 *    （M1 变异：删掉该子句 ⇒ 本文件必须红）；
 * 3. 审计在**同一事务**里、且在 COMMIT **之前**（M3 变异：删掉审计调用 ⇒ 本文件必须红，
 *    因为脚本里会看到"改了目录却没写审计就提交"）；
 * 4. `real` + **无池** ⇒ 503 `PROVIDER_UNAVAILABLE`、`retryable: false`、`body.data === undefined`
 *    （M2 变异：无池分支改成返回空数组 ⇒ 本文件必须红）。
 *
 * 为什么用**桩池**而不是真库：本机没有 Postgres（`.pg17` 不存在、5432 无监听），
 * 单元层只能证明"语句形状 + 参数顺序 + 事务边界"。真库行为（CHECK/触发/权限/G 码）
 * 需要 `tests/integration/**` 起 17.x 集群，本片**没有**做到 —— 报告里如实披露。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { createAdminOpsService } from '../../services/api/src/admin/ops/service.ts';
import { restrictAdminOpsToAccountsAuthority } from '../../services/api/src/admin/ops/accounts-only.ts';
import { ADMIN_CATEGORY_SQL, ADMIN_CATEGORY_TX } from '../../services/api/src/admin/ops/categories-pg.ts';

const API = '/api/v1';

/** 与 `tests/unit/admin-real-mode-fail-closed.test.mjs` 同形的**合成占位** real 环境（非真实凭据）。 */
const REAL_ENV = {
  APP_EXECUTION_MODE: 'real',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
  SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
  DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
  WECHAT_APP_ID: 'synthetic-not-a-real-appid',
  WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
  OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
};

const ALL_SCOPES = [
  'sources:read', 'sources:write', 'audit:read',
  'accounts:read', 'accounts:suspend',
  'jobs:read', 'jobs:cancel',
  'flags:read', 'flags:write',
];

const CROP_ROW = {
  id: 'crop_rice', revision: 1, type: 'crop',
  name: '水稻', description: '禾本科稻属栽培种', active: true,
};

/**
 * **桩池**：把每条 SQL 的文本与参数记下来，回答由 `respond(text, values)` 决定。
 *
 * `respond` 返回 `{ rows }`，抛错即模拟库错误（用来钉"审计失败 ⇒ 整体回滚"）。
 */
function createStubPool(respond) {
  const statements = [];
  const answer = async (text, values = []) => {
    statements.push({ text, values: [...values] });
    const result = await respond(text, values);
    return { rows: result.rows ?? [], rowCount: (result.rows ?? []).length };
  };
  return {
    statements,
    /** 只看分类字典相关语句（装配期别的端口也会发 SQL，混在一起会看不清顺序）。 */
    categoryStatements() {
      return statements.filter(
        (s) => /admin_categories|record_admin_category_update|^(BEGIN|COMMIT|ROLLBACK)$/.test(s.text),
      );
    },
    query: answer,
    async connect() {
      return { query: answer, release() {} };
    },
  };
}

async function seedAdmin(authStore) {
  const adminId = await authStore.createAdmin({
    loginName: `r68-a01-${Math.random().toString(36).slice(2, 10)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes: ALL_SCOPES,
  });
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: adminId, tokenHashHex: hashToken(token), authEpoch: 1,
    expiresAt: new Date(Date.now() + 3600 * 1000), audience: 'admin',
  });
  return { adminId, token };
}

// ---------------------------------------------------------------------------
// 0. 静态钉子：CAS 语句的**形状**（参数顺序与 `AND revision = $2` 是乐观锁的全部内容）
// ---------------------------------------------------------------------------

test('0) CAS 语句必须是 `UPDATE … WHERE id = $1 AND revision = $2` 且 revision 自增', () => {
  const sql = ADMIN_CATEGORY_SQL.commit;
  assert.match(
    sql,
    /^UPDATE public\.admin_categories SET name = \$3, description = \$4, active = \$5, revision = revision \+ 1, updated_at = now\(\) WHERE id = \$1 AND revision = \$2 RETURNING /,
    `CAS 语句形状变了（乐观锁会被悄悄去掉）：${sql}`,
  );
  assert.equal(ADMIN_CATEGORY_TX.begin, 'BEGIN');
  assert.equal(ADMIN_CATEGORY_TX.commit, 'COMMIT');
  assert.equal(ADMIN_CATEGORY_TX.rollback, 'ROLLBACK');
  // 审计不走表写、只走迁移 0049 的窄函数（运行时对 admin_audit_events 零权限）。
  assert.equal(ADMIN_CATEGORY_SQL.audit, 'SELECT public.record_admin_category_update($1, $2, $3, $4) AS audit_id');
  assert.ok(
    !/INSERT\s+INTO\s+public\.admin_audit_events/i.test(ADMIN_CATEGORY_SQL.audit),
    '⛔ 应用层不得直接写 public.admin_audit_events（运行时对该表零权限）',
  );
});

// ---------------------------------------------------------------------------
// 1. real + 有池 ⇒ 读面真读库（200，不是 503、不是空页）
// ---------------------------------------------------------------------------

test('1) real + 有池：listAdminCategories 200 且 SQL 真打 public.admin_categories', async () => {
  const authStore = createMemoryAuthStore();
  const pool = createStubPool((text) => (text === ADMIN_CATEGORY_SQL.list
    ? { rows: [CROP_ROW, { ...CROP_ROW, id: 'species_barnyardgrass', type: 'species', revision: 3, name: '稗' }] }
    : { rows: [] }));
  const app = buildApp({ config: loadConfig(REAL_ENV), store: authStore, pool });
  try {
    const { token } = await seedAdmin(authStore);
    const res = await app.inject({
      method: 'GET', url: `${API}/admin/categories`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200, `real 有池时分类读面不得再 503 ⇒ ${res.body}`);
    const body = res.json();
    assert.equal(body.data.items.length, 2, `必须如实返回库里的两行（不是空页）⇒ ${res.body}`);
    assert.deepEqual(body.data.items[0], {
      id: 'crop_rice', revision: 1, type: 'crop', name: '水稻', description: '禾本科稻属栽培种', active: true,
    });
    assert.equal(body.meta.execution_mode, 'real', '执行模式必须如实上报 real');

    const listed = pool.categoryStatements().filter((s) => s.text === ADMIN_CATEGORY_SQL.list);
    assert.equal(listed.length, 1, `读面必须每次真读一次库（⛔ 不做跨请求缓存）⇒ ${pool.statements.map((s) => s.text).join(' | ')}`);
    assert.deepEqual(listed[0].values, [], 'list 语句没有参数');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 2. real + 有池 ⇒ 写面 CAS + 同事务审计（语句序列与参数顺序）
// ---------------------------------------------------------------------------

test('2) real + 有池：editCategory 走 CAS + 同事务审计，参数顺序与语句序列精确', async () => {
  const authStore = createMemoryAuthStore();
  const updated = { ...CROP_ROW, revision: 2, name: '水稻（修订）', description: '修订后的说明', active: false };
  const pool = createStubPool((text) => {
    if (text === ADMIN_CATEGORY_SQL.commit) return { rows: [updated] };
    if (text === ADMIN_CATEGORY_SQL.audit) return { rows: [{ audit_id: '00000000-0000-4000-a000-00000000abc1' }] };
    return { rows: [] };
  });
  const app = buildApp({ config: loadConfig(REAL_ENV), store: authStore, pool });
  try {
    const { adminId, token } = await seedAdmin(authStore);
    const res = await app.inject({
      method: 'PATCH', url: `${API}/admin/categories/crop_rice`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'r68-a01-edit-0001',
        'if-match': '"1"',
      },
      payload: { name: '水稻（修订）', description: '修订后的说明', active: false },
    });
    assert.equal(res.statusCode, 200, `real 有池时分类编辑必须真的落库 ⇒ ${res.body}`);
    assert.deepEqual(res.json().data, updated, '响应必须是库 RETURNING 回来的那一行（不是内存记录）');
    assert.equal(res.headers.etag, '"2"', 'ETag 必须跟随新 revision');

    const sequence = pool.categoryStatements().map((s) => s.text);
    assert.deepEqual(sequence, [
      ADMIN_CATEGORY_TX.begin,
      ADMIN_CATEGORY_SQL.commit,
      ADMIN_CATEGORY_SQL.audit,
      ADMIN_CATEGORY_TX.commit,
    ], `写路径必须严格是 BEGIN → CAS → 审计 → COMMIT（审计在提交之前）⇒ ${sequence.join(' | ')}`);

    const cas = pool.categoryStatements()[1];
    assert.deepEqual(
      cas.values,
      ['crop_rice', 1, '水稻（修订）', '修订后的说明', false],
      '参数顺序必须是 [id, expectedRevision, name, description, active]（$1=$2 是 CAS 的定位与版本）',
    );

    const audit = pool.categoryStatements()[2];
    assert.deepEqual(
      audit.values,
      [adminId, 'crop_rice', 2, audit.values[3]],
      '审计参数必须是 [actorId, 变更后的分类 id, 变更后的 revision, requestId]（前三位由端口自己从 RETURNING 取）',
    );
    assert.match(String(audit.values[3]), /^[0-9a-f-]{36}$/i, 'requestId 必须是请求上下文里的 uuid');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 3. CAS 落空 ⇒ 409，且**没有**审计、**没有** COMMIT
// ---------------------------------------------------------------------------

test('3) 修订号过期：CAS 落空 ⇒ 409 REVISION_CONFLICT，且不写审计、不提交', async () => {
  const authStore = createMemoryAuthStore();
  const pool = createStubPool((text) => {
    if (text === ADMIN_CATEGORY_SQL.commit) return { rows: [] };            // CAS 没命中
    if (text === ADMIN_CATEGORY_SQL.currentRevision) return { rows: [{ revision: 7 }] }; // 行还在 ⇒ 是版本冲突
    return { rows: [] };
  });
  const app = buildApp({ config: loadConfig(REAL_ENV), store: authStore, pool });
  try {
    const { token } = await seedAdmin(authStore);
    const res = await app.inject({
      method: 'PATCH', url: `${API}/admin/categories/crop_rice`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'r68-a01-edit-0002',
        'if-match': '"1"',
      },
      payload: { name: '水稻（修订）', description: '修订后的说明', active: false },
    });
    assert.equal(res.statusCode, 409, `CAS 落空必须是契约声明的 409 ⇒ ${res.body}`);
    assert.equal(res.json().error.code, 'REVISION_CONFLICT');

    const sequence = pool.categoryStatements().map((s) => s.text);
    assert.deepEqual(sequence, [
      ADMIN_CATEGORY_TX.begin,
      ADMIN_CATEGORY_SQL.commit,
      ADMIN_CATEGORY_SQL.currentRevision,
      ADMIN_CATEGORY_TX.rollback,
    ], `落空时必须先分辨再回滚，且⛔ 不得写审计、⛔ 不得 COMMIT ⇒ ${sequence.join(' | ')}`);
    assert.ok(
      !pool.categoryStatements().some((s) => s.text === ADMIN_CATEGORY_SQL.audit),
      '⛔ 没有真改动就不许写 category.update 审计（那是伪造操作记录）',
    );
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 4. 审计写不进去 ⇒ 整体回滚 + 503（这一条是"审计不许被删"的钉子）
// ---------------------------------------------------------------------------

test('4) 审计失败：整个事务回滚、目录保持原样、对外 503', async () => {
  const authStore = createMemoryAuthStore();
  const pool = createStubPool((text) => {
    if (text === ADMIN_CATEGORY_SQL.commit) return { rows: [{ ...CROP_ROW, revision: 2 }] };
    if (text === ADMIN_CATEGORY_SQL.audit) {
      const error = new Error('SCOPE_DENIED');
      error.code = 'G0010';
      throw error;
    }
    return { rows: [] };
  });
  const app = buildApp({ config: loadConfig(REAL_ENV), store: authStore, pool });
  try {
    const { token } = await seedAdmin(authStore);
    const res = await app.inject({
      method: 'PATCH', url: `${API}/admin/categories/crop_rice`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'r68-a01-edit-0003',
        'if-match': '"1"',
      },
      payload: { name: '水稻（修订）', description: '修订后的说明', active: false },
    });
    assert.equal(res.statusCode, 503, `审计写不进去 ⇒ 必须 503（⛔ 不得"改了目录但没审计"）⇒ ${res.body}`);
    assert.equal(res.json().error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(res.json().error.retryable, false);

    const sequence = pool.categoryStatements().map((s) => s.text);
    assert.ok(sequence.includes(ADMIN_CATEGORY_TX.rollback), `审计失败必须回滚 ⇒ ${sequence.join(' | ')}`);
    assert.ok(!sequence.includes(ADMIN_CATEGORY_TX.commit), `⛔ 审计失败时不得提交 ⇒ ${sequence.join(' | ')}`);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 5. 成对反面：real + **无池** ⇒ 503（不返回空页、不落内存）
// ---------------------------------------------------------------------------

test('5) real + 无池：两个 operation 都是 503 PROVIDER_UNAVAILABLE（retryable:false，无 data）', async () => {
  const authStore = createMemoryAuthStore();
  const app = buildApp({ config: loadConfig(REAL_ENV), store: authStore });
  try {
    const { token } = await seedAdmin(authStore);
    const list = await app.inject({
      method: 'GET', url: `${API}/admin/categories`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(list.statusCode, 503, `无池时读面必须 503 ⇒ ${list.body}`);
    assert.equal(list.json().error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(list.json().error.retryable, false, '未接线是运维动作 ⇒ retryable 必须 false');
    assert.equal(list.json().data, undefined, '⛔ 不许返回空页（空页会被读成「平台没有分类」）');

    const edit = await app.inject({
      method: 'PATCH', url: `${API}/admin/categories/crop_rice`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'r68-a01-edit-0004',
        'if-match': '"1"',
      },
      payload: { name: 'n', description: 'd', active: true },
    });
    assert.equal(edit.statusCode, 503, `无池时写面必须 503 ⇒ ${edit.body}`);
    assert.equal(edit.json().error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(edit.json().error.retryable, false);
    assert.equal(edit.json().data, undefined, '⛔ 不许返回成功封套');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 6. 非回归：stub 模式仍走内存 store（既有单测/本地联调行为不变）
// ---------------------------------------------------------------------------

test('6) stub 模式：分类读仍是内存 store 的 200（既有行为不回归）', async () => {
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig({
      APP_EXECUTION_MODE: 'stub',
      LOG_LEVEL: 'silent',
      SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
    }),
    store: authStore,
  });
  try {
    const { token } = await seedAdmin(authStore);
    const res = await app.inject({
      method: 'GET', url: `${API}/admin/categories`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200, `stub 域分类读面必须仍是 200 ⇒ ${res.body}`);
    assert.ok(Array.isArray(res.json().data.items), 'stub 域必须返回列表封套');
    assert.equal(res.json().meta.execution_mode, 'stub');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 7. 外壳门：默认仍然是 reject（与首版逐字相同），只有 capabilities 置位才转发
// ---------------------------------------------------------------------------

test('7) 外壳：categoriesWired 未置位 ⇒ 两个 operation 仍是同一个 503；置位才转发', async () => {
  const inner = createAdminOpsService({ signingKey: 'r68-a01-test-signing-key-0123456789' });
  const closed = restrictAdminOpsToAccountsAuthority(inner, 'real 模式未接真实持久后端', {});
  for (const op of ['listAdminCategories', 'editCategory']) {
    await assert.rejects(
      () => closed[op]({ identity: { userId: '00000000-0000-4000-a000-00000000ad01' }, requestId: 'r' }),
      (error) => {
        assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `${op} 默认必须是 503`);
        assert.equal(error.retryable, false, `${op} 未接线 ⇒ retryable 必须 false`);
        return true;
      },
    );
  }
  const opened = restrictAdminOpsToAccountsAuthority(inner, 'real 模式未接真实持久后端', { categoriesWired: true });
  assert.equal(opened.listAdminCategories, inner.listAdminCategories, 'categoriesWired ⇒ 读面必须转发的就是 inner 本身');
  assert.equal(opened.editCategory, inner.editCategory, 'categoriesWired ⇒ 写面必须转发的就是 inner 本身');
});

/**
 * 8) 回填账守卫（N1 的钉子；列形态见下一条 N4）。
 *
 * 背景：回填的 `ON CONFLICT (id) DO NOTHING` 在「crops 与 species 出现同一个 id」时会**静默丢一行**
 * （没有 NOTICE、没有断言）；而 `ADD COLUMN IF NOT EXISTS` 遇到「列已存在但不带 NOT NULL / DEFAULT」
 * 什么也不做。两条都是「迁移报成功、库却是错的」，所以钉住的是**判据在位**，不是文案：
 *
 * - 回填**前**必须有 id 交集检查，且冲突走 `G0019 CATALOG_BACKFILL_ID_COLLISION`（fail-closed）；
 * - 回填**后**必须有「来源行是否都落表」的断言，走 `G0019 CATALOG_BACKFILL_INCOMPLETE`；
 * - 两条都必须 `RAISE NOTICE` 打出真实行数（重放时也打，否则「搬了多少行」只能靠猜）。
 */
test('8) 回填账（N1）：id 冲突 fail-closed、回填前后各一条 NOTICE、缺行走 G0019', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const up = readFileSync(resolve(root, 'services/api/db/migrations/0049_admin_categories.sql'), 'utf8');

  const firstCropsInsert = up.indexOf("SELECT c.id,\n       'crop',");
  const firstSpeciesInsert = up.indexOf("SELECT s.id,\n       'species',");
  assert.ok(firstCropsInsert > 0 && firstSpeciesInsert > firstCropsInsert, '两条回填 INSERT 必须在迁移里（crops 先、species 后）');

  const collisionAt = up.indexOf("'CATALOG_BACKFILL_ID_COLLISION'");
  const incompleteAt = up.indexOf("'CATALOG_BACKFILL_INCOMPLETE'");
  assert.ok(collisionAt > 0, '缺少 id 冲突判据（G0019 CATALOG_BACKFILL_ID_COLLISION）：同 id 的 species 行会被 ON CONFLICT 静默丢弃');
  assert.ok(incompleteAt > 0, '缺少回填后行数断言（G0019 CATALOG_BACKFILL_INCOMPLETE）');
  assert.ok(collisionAt < firstCropsInsert, 'id 冲突检查必须在**回填之前**（写在 INSERT 之后就只能事后补救）');
  assert.ok(incompleteAt > firstSpeciesInsert, '行数断言必须在**两条 INSERT 之后**');
  assert.match(
    up,
    /JOIN public\.species AS s ON s\.id = c\.id/u,
    'id 冲突必须靠 crops ⋈ species 的 id 交集求出来（不是靠 count 猜）',
  );
  assert.ok(
    (up.match(/RAISE NOTICE/gu) ?? []).length >= 2,
    '回填前/后各要一条 RAISE NOTICE 打出真实行数（否则「搬了多少行」无从核对）',
  );
  assert.match(
    up,
    /NOT EXISTS \(\s*SELECT 1 FROM public\.admin_categories AS a WHERE a\.id = s\.id AND a\.type = 'species'\)/u,
    '行数断言必须逐行核对「species 来源行是否落表」（只比总数会漏掉"少一行、多一行正好抵消"）',
  );
});

test('9) 列形态（N4）：ADD COLUMN IF NOT EXISTS 之后必须用 information_schema 复核 NOT NULL/DEFAULT', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const up = readFileSync(resolve(root, 'services/api/db/migrations/0049_admin_categories.sql'), 'utf8');

  assert.ok(up.includes("'CATALOG_COLUMN_SHAPE'"), '缺少列形态判据（G0019 CATALOG_COLUMN_SHAPE）');
  assert.ok(
    up.includes('information_schema.columns'),
    '列形态必须查 information_schema.columns（ADD COLUMN IF NOT EXISTS 不会修正已存在的列）',
  );
  assert.match(up, /actual\.is_nullable IS DISTINCT FROM 'NO'/u, '必须核对 NOT NULL（is_nullable = NO）');
  assert.match(up, /actual\.column_default IS NULL/u, '必须核对 DEFAULT 在位（回填/幂等依赖它）');
  for (const column of ['name', 'description', 'active', 'revision', 'updated_at']) {
    assert.ok(
      new RegExp(`\\('${column}',\\s*'`).test(up),
      `列形态复核必须逐列登记 ${column}（五列缺一列就等于那一列没人管）`,
    );
  }
});

/**
 * 10) 迁移 0049 形状守卫（M4 变异的钉子）：删掉任一列、或把 NOT NULL 列写成没有 DEFAULT、
 *    或把窄函数 / 回滚预检写丢，本用例必须红。
 *
 * 判据不复制迁移正文（那会变成"改一处要改两处"的谎），只钉**不可退让的形状**：
 * 每列都以 ADD COLUMN IF NOT EXISTS 出现；凡 NOT NULL 必须同时给 DEFAULT（幂等/回填）；
 * 四条 CHECK 与窄函数的 SECURITY DEFINER + search_path 钉法必须在位；回滚必须先预检再删。
 */
test('10) 迁移 0049 形状：六列齐、NOT NULL 必有 DEFAULT、四条 CHECK、窄函数钉 search_path、回滚先预检', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const up = readFileSync(resolve(root, 'services/api/db/migrations/0049_admin_categories.sql'), 'utf8');
  const down = readFileSync(
    resolve(root, 'services/api/db/migrations/rollback/0049_admin_categories.down.sql'),
    'utf8',
  );

  assert.ok(up.includes('CREATE TABLE IF NOT EXISTS public.admin_categories'), '建表必须 IF NOT EXISTS（幂等）');
  for (const column of ['name', 'description', 'active', 'revision', 'updated_at']) {
    assert.match(
      up,
      new RegExp(`ALTER TABLE public\\.admin_categories\\s+ADD COLUMN IF NOT EXISTS ${column}\\b`),
      `列 ${column} 必须以 ADD COLUMN IF NOT EXISTS 出现（删列 / 改成裸 ADD COLUMN 都要在这里红）`,
    );
  }
  for (const line of up.split('\n')) {
    // 注释行不是 DDL：N4 的说明段里也会出现「ADD COLUMN IF NOT EXISTS … NOT NULL」字样，
    // 把它当成待校验的列语句会变成"改注释也要跟着改 DEFAULT"的假红。
    if (line.trimStart().startsWith('--')) continue;
    if (!/ADD COLUMN/.test(line)) continue;
    if (!/NOT NULL/.test(line)) continue;
    assert.match(line, /DEFAULT/, `NOT NULL 列必须给 DEFAULT：${line.trim()}`);
  }
  for (const constraint of [
    'admin_categories_type_closed',
    'admin_categories_name_length',
    'admin_categories_description_length',
    'admin_categories_revision_positive',
  ]) {
    assert.ok(up.includes(constraint), `缺少约束 ${constraint}`);
  }
  assert.match(up, /CREATE OR REPLACE FUNCTION public\.record_admin_category_update\(/, '审计窄函数必须在迁移里建');
  assert.ok(up.includes('SECURITY DEFINER'), '窄函数必须 SECURITY DEFINER');
  assert.ok(up.includes('SET search_path = pg_catalog'), '窄函数必须钉 search_path');
  assert.ok(up.includes("'category.update'"), '审计 action 必须是字面量 category.update');
  assert.match(up, /REVOKE ALL ON FUNCTION public\.record_admin_category_update\(/u, '窄函数必须 REVOKE ALL … FROM PUBLIC');

  assert.ok(down.includes('G0019'), '回滚必须先预检（G0019 中止）');
  assert.ok(down.includes('DROP TABLE public.admin_categories'), '回滚必须删表');
  assert.ok(down.includes('DROP FUNCTION public.record_admin_category_update('), '回滚必须删函数');
});

/**
 * 11) 调用期 fail-closed（M2 变异的真钉子）：**直接**构造服务、`execution_mode='real'`、
 *     没有注入分类端口 ⇒ 两个 operation 都必须抛 503，⛔ 不许静默降级成内存种子、⛔ 不许返回空页。
 *
 * 为什么单列一条：第 5 条走 `buildApp` + `REAL_ENV`，那条路径**必然有池**（`loadConfig` 在 real 模式
 * 要求 `DATABASE_URL`），它证的是"有池但连不上 ⇒ 503"。真正"没有端口"的分支只有从服务层直接构造
 * 才走得到 —— 那正是外壳门之外的第二道门（装配期门 + 调用期门）。
 */
test('11) 调用期 fail-closed：real 且没有分类端口 ⇒ 两 op 均 503（不落内存、不返回空页）', async () => {
  const service = createAdminOpsService({
    executionMode: 'real',
    signingKey: 'synthetic-not-a-real-signing-key',
  });
  const context = {
    identity: {
      userId: '00000000-0000-4000-a000-00000000ad01',
      authEpoch: 1,
      role: 'admin',
      audience: 'admin',
      scopes: ['sources:read', 'sources:write'],
    },
    requestId: '00000000-0000-4000-a000-00000000cd01',
    ifMatch: '"1"',
  };

  await assert.rejects(
    () => service.listAdminCategories(context),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE', '无端口 + real ⇒ 读面必须 503');
      assert.equal(error.retryable, false, '未接线是运维动作 ⇒ retryable 必须 false');
      assert.match(error.message, /拒绝返回空页/, '503 文案必须说清"不返回空页"的理由');
      return true;
    },
  );

  await assert.rejects(
    () => service.editCategory(context, 'crop_rice', { name: 'n', description: 'd', active: true }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE', '无端口 + real ⇒ 写面必须 503');
      assert.equal(error.retryable, false);
      return true;
    },
  );
});
