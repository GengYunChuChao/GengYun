/**
 * GY-R27 S10-r1（#10）· **「表未迁移」≠「数据库故障」**的判据（记录型假池，不连库）。
 *
 * 背景（CI `real-pg-17.11` 抓到的真回归，证据页「R27-S10-r1」一节）：真库集成脚本会只应用
 * **迁移子集**建库（`tests/integration/conversations-pg.mjs:57` 只跑
 * `0001/0002/0005/0008/0010/0012/0013`），那种库里**没有** `ocr_*` 三表。首版实现把
 * `42P01`（表不存在）与真数据库故障一起折成 `PROVIDER_UNAVAILABLE`「OCR 数据库暂不可用」，
 * 于是 OCR 作业源的读路径把**无关域**的 `GET /jobs/{id}` 打成 503（本该 200/404）。
 *
 * 本文件锁三层判据（缺一不可）：
 *  A. **读类**（`getJob`/`getOcr`/`findIdempotent`）：确认未迁移 ⇒ `null`，⛔ 不抛、⛔ 不 503；
 *  B. **写类**（9 个）：确认未迁移 ⇒ {@link OcrTablesMissingError}，文案点名 `0024`、`retryable:false`
 *     —— ⛔ 绝不静默丢写、⛔ 绝不退化成内存 store；
 *  C. **探测本身失败** ⇒ `unknown` ⇒ fail-closed 抛（⛔ **不得**当成 `missing` 放过读类）。
 *
 * 另含缓存失效与错误分类不被吞掉的性质（负控制见证据页 §R27-S10-r1）：
 *  - 确定结论（`ready`/`missing`）才进缓存；`unknown` 不入缓存 ⇒ 下一次调用重探；
 *  - 业务语句撞上 `42P01`（探测之后表被回滚）⇒ 失效缓存，下一次调用**重新探测**；
 *  - `57014`/`55P03` 仍折成 `PROVIDER_TIMEOUT`，其余数据库故障仍是可重试的
 *    `PROVIDER_UNAVAILABLE`（`instanceof ApiError` 前移只用于原样透出 `OcrTablesMissingError`，
 *    ⛔ 不吞分类）。
 *
 * 与 `tests/unit/ocr-store-pg.test.mjs` 的分工：那份文件锁**语句形状**（原有断言逐条不动），
 * 本文件锁**就绪探测 + 读写分化**；两者都用记录型假池，不连真库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { ApiError } from '../../services/api/src/errors.ts';
import {
  OcrStoreConflictError,
  OcrTablesMissingError,
  classifyOcrDatabaseError,
  createPostgresOcrStore,
} from '../../services/api/src/ocr/store-pg.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const MEDIA = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-10-20T08:00:00.000Z');

const PROBE_MARKER = 'to_regclass';

/** 事务控制语句：固定应答，不消耗业务语句脚本（与 `ocr-store-pg.test.mjs` 同口径）。 */
const CONTROL_SQL = /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL .*|RELEASE)$/;

/**
 * 记录型假池。
 *
 * - `script`：**业务语句**的应答序列（`Error` 实例 ⇒ 该条抛错），就绪探测**不**消耗它；
 * - `probe`：就绪探测的应答，`'ready' | 'missing' | 'unknown' | Error`（`Error` ⇒ 探测本身抛错）。
 *   探测单独进 `probes` 流，不进 `log`/`sqls`（既有语句位置断言因此逐条保持有效）。
 */
function makeDb({ script = [], probe = 'ready' } = {}) {
  const log = [];
  const probes = [];
  let connectCount = 0;
  let probeState = probe;
  let index = 0;

  const answerProbe = () => {
    if (probeState instanceof Error) throw probeState;
    if (probeState === 'ready') return { rows: [{ ready: true }] };
    if (probeState === 'missing') return { rows: [{ ready: false }] };
    if (probeState === 'unknown') return { rows: [] };
    throw new Error(`测试夹具错误：未知的 probe=${String(probeState)}`);
  };

  const next = async (text, values) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    if (sql.includes(PROBE_MARKER)) {
      probes.push({ sql, values });
      return answerProbe();
    }
    log.push({ sql, values });
    if (CONTROL_SQL.test(sql)) return { rows: [] };
    const response = script[index];
    index += 1;
    if (response instanceof Error) throw response;
    return { rows: response ?? [] };
  };

  const pool = {
    query: next,
    async connect() {
      connectCount += 1;
      return {
        query: next,
        release() {
          log.push({ sql: 'RELEASE' });
        },
      };
    },
  };

  const sqls = () => log.map((entry) => entry.sql);
  const store = createPostgresOcrStore({ pool });
  return {
    pool,
    log,
    probes,
    sqls,
    store,
    /** 运行中切换探测结论（模拟迁移被应用/回滚）。 */
    setProbe(value) {
      probeState = value;
    },
    connects: () => connectCount,
  };
}

function jobInput(overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    kind: 'ocr',
    ownerUserId: OWNER,
    ocrId: randomUUID(),
    mediaId: MEDIA,
    mediaRevision: 2,
    state: 'queued',
    deadlineAt: new Date(T0.getTime() + 30_000),
    createdAt: T0,
    updatedAt: T0,
    errorCode: null,
    ...overrides,
  };
}

function ocrInput(overrides = {}) {
  const fields = { registration_number: 'PD20261234', name: '草甘膦异丙胺盐可溶液剂' };
  return {
    id: randomUUID(),
    revision: 1,
    ownerUserId: OWNER,
    mediaId: MEDIA,
    mediaRevision: 2,
    rawFields: fields,
    correctedFields: fields,
    verification: { match_state: 'insufficient', registration: null, conflict_fields: [], missing_fields: [], dose_cards: [] },
    modelVersion: 'stub-v1',
    createdAt: T0,
    updatedAt: T0,
    deleted: false,
    ...overrides,
  };
}

const idempotencyInput = () => ({
  requestHash: 'h1',
  expiresAt: new Date(T0.getTime() + 60_000),
  payload: { job_id: 'job-1' },
  pending: true,
});

/** 断言：这是 `OcrTablesMissingError`，且文案点名 0024、**不可重试**。 */
function assertTablesMissing(error) {
  assert.ok(error instanceof OcrTablesMissingError, `必须是 OcrTablesMissingError（现场：${error?.name}）`);
  assert.ok(error instanceof ApiError, 'OcrTablesMissingError 仍须是 ApiError（HTTP 503 通道）');
  assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(error.retryable, false, '迁移未执行只能靠部署动作解决 ⇒ 必须 retryable:false');
  assert.match(error.message, /0024_ocr_persistence\.sql/, '文案必须点名迁移文件，便于运维定位');
  assert.match(error.message, /未迁移/);
  return true;
}

const READERS = [
  ['getJob', (db) => db.store.getJob(randomUUID())],
  ['getOcr', (db) => db.store.getOcr(randomUUID())],
  ['findIdempotent', (db) => db.store.findIdempotent('scope-1', 'keyhash-1')],
];

const WRITERS = [
  ['insertJob', (db) => db.store.insertJob(jobInput())],
  ['updateJob', (db) => db.store.updateJob(randomUUID(), 1, (current) => ({ ...current, revision: current.revision + 1 }))],
  [
    'commitTerminal',
    (db) => db.store.commitTerminal(randomUUID(), 1, { state: 'succeeded', errorCode: null }, null, T0),
  ],
  ['insertOcr', (db) => db.store.insertOcr(ocrInput())],
  ['updateOcr', (db) => db.store.updateOcr(randomUUID(), 1, (current) => ({ ...current, revision: current.revision + 1 }))],
  ['claimIdempotent', (db) => db.store.claimIdempotent('scope-1', 'keyhash-1', idempotencyInput(), T0)],
  ['finalizeIdempotent', (db) => db.store.finalizeIdempotent('scope-1', 'keyhash-1', { accepted: true })],
  ['releaseIdempotent', (db) => db.store.releaseIdempotent('scope-1', 'keyhash-1')],
  ['purgeIdempotent', (db) => db.store.purgeIdempotent(T0)],
];

// ---------------------------------------------------------------------------
// A. 读类：确认未迁移 ⇒ null（不是抛、不是 503）
// ---------------------------------------------------------------------------

test('[A] 子集迁移库（探测=missing）：三个读类一律返回 null，且不发出任何业务 SQL', async () => {
  for (const [name, read] of READERS) {
    const db = makeDb({ probe: 'missing' });
    assert.equal(await read(db), null, `${name} 在「表未迁移」时必须返回 null（不是抛错、不是 503）`);
    assert.equal(db.log.length, 0, `${name} 不得对不存在的表发业务 SQL（现场：${db.sqls().join(' | ')}）`);
    assert.equal(db.probes.length, 1, `${name} 必须先做一次就绪探测`);
  }
});

test('[A] 确定结论 missing 进缓存：连续读只探测一次（不逐请求打库探测）', async () => {
  const db = makeDb({ probe: 'missing' });
  assert.equal(await db.store.getJob(randomUUID()), null);
  assert.equal(await db.store.getOcr(randomUUID()), null);
  assert.equal(await db.store.findIdempotent('s', 'k'), null);
  assert.equal(db.probes.length, 1, 'missing 是确定结论 ⇒ 缓存；不得每次调用都探测');
  assert.equal(db.log.length, 0);
});

test('[A] 探测=ready 后表被回滚（业务语句撞 42P01）：读类仍返回 null，且缓存失效后**重新探测**', async () => {
  const db = makeDb({
    probe: 'ready',
    script: [Object.assign(new Error('relation "public.ocr_jobs" does not exist'), { code: '42P01' })],
  });
  assert.equal(await db.store.getJob(randomUUID()), null, '读路径撞 42P01 ⇒ 按「未迁移」返回 null');
  assert.equal(db.probes.length, 1);

  // 回滚后缓存必须失效：下一次调用重新探测（而不是继续按旧 ready 发业务 SQL）。
  db.setProbe('missing');
  assert.equal(await db.store.getJob(randomUUID()), null);
  assert.equal(db.probes.length, 2, '42P01 之后必须失效缓存并重新探测（负控制③：去掉失效 ⇒ 本断言红）');
  assert.equal(db.log.length, 1, '第二次读只应发生一次探测，不得再发业务 SQL');
});

// ---------------------------------------------------------------------------
// B. 写类：确认未迁移 ⇒ OcrTablesMissingError（fail-closed，绝不静默丢写）
// ---------------------------------------------------------------------------

test('[B] 子集迁移库（探测=missing）：九个写类一律抛 OcrTablesMissingError（点名 0024 / retryable:false）', async () => {
  for (const [name, write] of WRITERS) {
    const db = makeDb({ probe: 'missing' });
    await assert.rejects(() => write(db), assertTablesMissing, `${name} 必须 fail-closed`);
    assert.equal(db.log.length, 0, `${name} 在写前置门就应拒绝，不得对不存在的表发业务 SQL`);
    assert.equal(db.connects(), 0, `${name} 必须在开事务/拿连接之前拒绝`);
  }
});

test('[B] 写类 reject 的**不是** null、也不是普通「数据库暂不可用」：错误类型与文案可区分', async () => {
  const db = makeDb({ probe: 'missing' });
  let caught = null;
  try {
    await db.store.insertOcr(ocrInput());
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null, '写类不得静默成功');
  assertTablesMissing(caught);
  assert.notEqual(caught.message, 'OCR 数据库暂不可用', '「表未迁移」不得与「数据库故障」同文案');
  assert.equal(caught.name, 'OcrTablesMissingError');
});

test('[B] missing 缓存：连续写只探测一次（不逐请求探测），且始终 fail-closed', async () => {
  const db = makeDb({ probe: 'missing' });
  await assert.rejects(() => db.store.insertJob(jobInput()), assertTablesMissing);
  await assert.rejects(() => db.store.purgeIdempotent(T0), assertTablesMissing);
  assert.equal(db.probes.length, 1);
  assert.equal(db.log.length, 0);
});

// ---------------------------------------------------------------------------
// C. 探测本身失败 ⇒ unknown ⇒ fail-closed 抛（⛔ 不得当成 missing 放过读）
// ---------------------------------------------------------------------------

test('[C] 探测抛错 ⇒ unknown ⇒ 读类 fail-closed（不得返回 null 冒充「没有作业」）', async () => {
  for (const [name, read] of READERS) {
    const db = makeDb({ probe: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    let caught = null;
    try {
      const value = await read(db);
      assert.fail(`${name} 在探测失败时不得返回 ${JSON.stringify(value)}（未知 ≠ 未迁移）`);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ApiError, `${name} 探测失败必须抛 ApiError`);
    assert.equal(caught instanceof OcrTablesMissingError, false, '探测失败不得伪装成「表未迁移」');
    assert.equal(caught.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(caught.retryable, true, '连接/权限/超时是可通过重试/修复恢复的数据库故障');
    assert.equal(db.log.length, 0);
  }
});

test('[C] 探测抛错 ⇒ unknown 不入缓存：下一次调用会重新探测（故障恢复后即可放行）', async () => {
  const db = makeDb({ probe: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  await assert.rejects(() => db.store.getJob(randomUUID()), ApiError);
  assert.equal(db.probes.length, 1);
  db.setProbe('ready');
  const db2 = db;
  // 同一条 store：故障恢复后重新探测 ⇒ ready ⇒ 正常返回 null（无该作业）。
  assert.equal(await db2.store.getJob(randomUUID()), null);
  assert.equal(db2.probes.length, 2, 'unknown 绝不入缓存（负控制②按 missing 处理 ⇒ 第二次不会探测）');
});

test('[C] 探测形状读不懂（无 ready 列）⇒ unknown ⇒ 同样 fail-closed', async () => {
  const db = makeDb({ probe: 'unknown' });
  await assert.rejects(
    () => db.store.getOcr(randomUUID()),
    (error) => error instanceof ApiError && error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === true,
  );
});

test('[C] 探测超时/锁不可用（57014/55P03）仍保留专门分类 PROVIDER_TIMEOUT（不被 instance ApiError 吞掉）', async () => {
  for (const code of ['57014', '55P03']) {
    const db = makeDb({ probe: Object.assign(new Error(`probe failed ${code}`), { code }) });
    await assert.rejects(
      () => db.store.getJob(randomUUID()),
      (error) => {
        assert.equal(error instanceof OcrTablesMissingError, false);
        assert.equal(error.code, 'PROVIDER_TIMEOUT', `${code} 必须仍是超时分类`);
        assert.equal(error.retryable, true);
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// 分类不被吞：真数据库故障照旧抛；OcrTablesMissingError 原样透出
// ---------------------------------------------------------------------------

test('真数据库故障（非 42P01）读类照旧抛（不被 readOrMissing 吞成 null）', async () => {
  const db = makeDb({
    probe: 'ready',
    script: [Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })],
  });
  await assert.rejects(
    () => db.store.getJob(randomUUID()),
    (error) => error instanceof ApiError && error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === true,
  );
});

test('OcrTablesMissingError 穿过 classifyOcrDatabaseError 时原样透出（instanceof ApiError 前移不得改写）', () => {
  const original = new OcrTablesMissingError();
  assert.throws(
    () => classifyOcrDatabaseError(original),
    (error) => error === original && error.retryable === false,
  );
  // 冲突错误仍优先于 ApiError 分支（顺序：冲突 → ApiError → 42P01/57014/55P03）。
  assert.throws(
    () => classifyOcrDatabaseError(new OcrStoreConflictError('任务 id 冲突')),
    (error) => error instanceof OcrStoreConflictError && error.message === '任务 id 冲突',
  );
});

test('写类业务语句撞 42P01：失效缓存 ⇒ 本次 fail-closed，下一次重新探测', async () => {
  const db = makeDb({
    probe: 'ready',
    script: [Object.assign(new Error('relation "public.ocr_idempotency" does not exist'), { code: '42P01' })],
  });
  await assert.rejects(() => db.store.purgeIdempotent(T0), assertTablesMissing);
  assert.equal(db.probes.length, 1);
  db.setProbe('missing');
  await assert.rejects(() => db.store.purgeIdempotent(T0), assertTablesMissing);
  assert.equal(db.probes.length, 2, '撞 42P01 后必须重探（旧 ready 缓存不得继续用于写）');
  assert.equal(db.log.length, 1, '第二次写应被前置门拦住，不再发 DELETE');
});
