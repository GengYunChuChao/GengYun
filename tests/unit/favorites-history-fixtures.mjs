/**
 * GY-I16（#16）· 收藏／历史测试夹具。
 *
 * 声明（必须如实，不得被引用为端到端证据）：
 *   这里的用户、目标引用、可见性与任务状态都是**合成输入**，用于验证确定性服务语义
 *   （归属、去重、取消、读取时重查、失败可见、幂等/CAS、分页、不可变出口、F13 删除接线）。
 *   它们**不是**真实识别结果，也**不是**"收藏/历史已端到端可用"的证据：
 *   - 生产装配下的引用可用性端口**已于 #167 接线**（逐次派生；无库/核不到即 unavailable），
 *     本夹具的"可用"仍由可控替身给出；
 *   - **识别/OCR → 历史的写入接线属跨线**（本片只交付内部口），因此本夹具用内部口
 *     `appendHistory` 直接落行 —— 这正是"替身/未验证"的一部分。
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { ApiError, buildErrorEnvelope } from '../../services/api/src/errors.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createFavoritesService } from '../../services/api/src/favorites/service.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createHistoryService } from '../../services/api/src/history/service.ts';
import {
  createUnwiredHistoryCascadePort,
  createWiredHistoryCascadePort,
} from '../../services/api/src/history/cascade.ts';
import { createUnwiredHistoryJobPort, createWiredHistoryJobPort } from '../../services/api/src/history/job.ts';
import {
  createUnwiredVisibilityPort,
  createWiredVisibilityPort,
  REFERENCE_UNAVAILABLE_REASONS,
} from '../../services/api/src/targetref/visibility.ts';

export {
  ApiError,
  buildErrorEnvelope,
  createUnwiredHistoryCascadePort,
  createUnwiredHistoryJobPort,
  createUnwiredVisibilityPort,
  createWiredHistoryCascadePort,
  createWiredHistoryJobPort,
  createWiredVisibilityPort,
  REFERENCE_UNAVAILABLE_REASONS,
};

/** 仅测试用签名密钥（不是真实密钥、不入库、不入日志）。 */
export const TEST_SIGNING_KEY = 'gy-i16-favorites-history-test-signing-key';

// ---------------------------------------------------------------------------
// PGlite 夹具（本片两个 HTTP 用例的「real + 有 pool」臂共用；GY-I16 阶段 2 追加）
//
// 只证明 **SQL 语义**：唯一约束去重、CAS 删除、幂等台账真落库。
// **不构成** PG17 真机验收 —— 真库覆盖在 `tests/integration/favorites-history-pg.mjs`，
// 同一批断言在那里面再跑一遍（迁移由同一个运行器按序号应用）。
// ---------------------------------------------------------------------------

/** 收藏/历史落库所需的最小迁移集：`0001`（`users` 外键目标）+ `0018`（本片新表）。 */
export const PG_MIGRATIONS = ['0001_initial_schema', '0018_favorites_history'];

/**
 * C1b（#17 P0-2 / #12 P0-3）追加：注销闭集扩到消息域与会话域后，用例需要
 * `public.messages`（`0019`）、共享幂等台账 `public.idempotency_keys`（`0008`）与
 * 会话三张表（`0013`）—— 否则对应域的清理语句会撞 `42P01`（不是"清完了"，而是"表都没有"）。
 *
 * 单独一个常量而不是改 `PG_MIGRATIONS`：既有收藏/历史用例的迁移集**逐字不动**。
 */
export const PG_MIGRATIONS_WITH_MESSAGES = [
  ...PG_MIGRATIONS,
  '0008_auth_session',
  '0013_conversations',
  '0019_messages_persistence',
];

/**
 * #15 社区域（R31-S6）追加：注销闭集无条件注入 `community` 之后，用例还必须带上社区五张表
 * （`0022` 的 `community_posts` / `community_comments` / `community_likes` / `community_reports`
 * + 本域幂等台账 `community_idempotency`）—— 否则注销清理的 SELECT/UPDATE/DELETE 会撞
 * `42P01`（`undefined_table`），协调器把该模块折叠成 `blocked`：那不是"注销已完成"，而是
 * "表都没有"。真库（PG17）覆盖在 `tests/integration/community-pg.mjs`。
 *
 * R31-F13（迁移 `0030`）再追加：运行时 SQL 现在**读写** `anonymized_author_ref`（行内注销引用）
 * 并在注销事务里 `SET author_id = NULL`。缺 0030 ⇒ `42703`（`undefined_column`），同理会把
 * 该模块折叠成 blocked 并让"点赞物理删/保留读数"全部失真。**这一条是运行时依赖，不是可选项**：
 * 加/删列清单时必须同步这里（与 `20-login-roles.sql` 的列级授权是同一批列）。
 *
 * R32（迁移 `0032`，#15 在 #483 之后的去身份残留）再追加：注销清理现在也把举报的
 * `reporter_id` 置 NULL 并写入行内 `anonymized_author_ref`，剩余读数还要 `count(*)` 第三张表。
 * 缺 0032 就是 `42703`（`undefined_column`）一类，同理会把该模块折叠成 blocked —— 这不是
 * "清理完成"。**这一条仍是运行时依赖，不是可选项**：0032 与 `20-login-roles.sql` 的举报表
 * 列清单是同一批列。
 *
 * 同样单独一个常量而不是改上面两个迁移集：既有收藏/历史/消息/会话用例的迁移集**逐字不动**。
 */
export const PG_MIGRATIONS_WITH_COMMUNITY = [
  ...PG_MIGRATIONS_WITH_MESSAGES,
  '0022_community_persistence',
  '0030_community_author_ref',
  '0032_community_report_reporter_ref',
];

/**
 * GY-R34-I19 追加：注销闭集扩到识别域（四表）与语音域（三表）且同属**装配期无条件注入**之后，
 * 任何走真实 `buildApp` 装配的用例都必须带上 `0025_recognitions_persistence`（`recognition_jobs`
 * / `recognition_records` / `recognition_selections` / `recognition_idempotency`）与
 * `0026_speech_persistence`（`speech_jobs` / `transcriptions` / `speech_idempotency`）。
 *
 * 缺表不是"清完了 0 行"，而是 `probeTables()` 判 missing、写类 fail-closed（存储层刻意这样设计），
 * 于是协调器把这两域折叠成 `blocked`——用例会看到 `completed` 变 `blocked`。
 *
 * 依据（实读迁移原文，两文件只依赖 `public.users`，`0001` 已建）：
 * `0025:110/134/163-164` 与 `0026:92/115` 全是 `REFERENCES public.users (id) ON DELETE CASCADE`。
 * 同样单独一个常量：`PG_MIGRATIONS_WITH_COMMUNITY` 逐字不动，其他用例的迁移集不受影响。
 */
export const PG_MIGRATIONS_WITH_DELETION_DOMAINS = [
  ...PG_MIGRATIONS_WITH_COMMUNITY,
  // R34 片 3（#19 / #10）：闭集再扩到 OCR 域三表（`ocr_jobs` / `ocr_records` /
  // `ocr_idempotency`，迁移 `0024_ocr_persistence`）之后，同一条规则照旧成立 —— 缺 0024 ⇒
  // `requireTables()` 判 missing、写类 fail-closed（存储层刻意这样设计）⇒ 协调器把该域
  // 折叠成 `blocked`，用例会看到 `completed` 变 `blocked`。0024 只依赖 `public.users`（`0001` 已建）。
  // ⚠️ 与前两域方向**相反**：识别/语音靠 0034 的 definer 函数（零表级 DELETE），OCR 三表是
  // 用户 2026-10-24 批准的**表级** `GRANT DELETE` 例外 —— 所以这里的 DELETE 是真表权限。
  '0024_ocr_persistence',
  '0025_recognitions_persistence',
  '0026_speech_persistence',
  // 0034 是本片清理的唯一写路径（两条 SECURITY DEFINER 函数）。PG 存储的 `purgeOwnerData`
  // 现在调 `public.purge_owner_recognitions(uuid)` / `purge_owner_speech(uuid)`，
  // 少了它这两域会拿到 42883 并被折叠成 `blocked`（用例会看到 completed → blocked）。
  '0034_r34_owner_content_purge',
];

export function migrationSql(name) {
  return readFileSync(new URL(`../../services/api/db/migrations/${name}.sql`, import.meta.url), 'utf8');
}

/**
 * 迁移后的 PGlite 池（结构上与 `db/pool.ts` 的 `PgPool` 兼容：`query` + `connect().release()`）。
 * 返回 `{ db, pool }`；`db` 供用例直接核对**真表**行（不是看内存 Map 自证）。
 */
export async function pglitePool(t, migrations = PG_MIGRATIONS) {
  const db = new PGlite();
  for (const name of migrations) await db.exec(migrationSql(name));
  t.after(() => db.close());
  const run = (...args) => db.query(...args);
  return { db, pool: { query: run, connect: async () => ({ query: run, release: () => {} }) } };
}


export const USER_A = Object.freeze({
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'user',
  authEpoch: 1,
});
export const USER_B = Object.freeze({
  userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  role: 'user',
  authEpoch: 1,
});
export const ADMIN = Object.freeze({
  userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  role: 'admin',
  authEpoch: 1,
});

/** 一个**不存在**的合法 uuid（用于"他人收藏/历史"与"完全不存在"的同形比较）。 */
export const ABSENT_ID = '00000000-0000-4000-8f00-0000000000ff';

/** 契约 `Favorite` 的键集（`additionalProperties:false` 的逐字段比对基准）。 */
export const FAVORITE_KEYS = [
  'id',
  'revision',
  'target_ref',
  'reference_state',
  'unavailable_reason',
  'created_at',
];

/** 契约 `History` 的键集。 */
export const HISTORY_KEYS = ['id', 'revision', 'kind', 'target_ref', 'job_state', 'reference_state', 'created_at'];

/** 契约 `TargetRef` 的键集。 */
export const TARGET_REF_KEYS = ['type', 'id', 'revision'];

/** 生成契约格式的确定性 uuid。 */
export function makeIdFactory(namespace = '1') {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8${namespace}00-${String(counter).padStart(12, '0')}`;
  };
}

/** 合法幂等键（契约要求 8..128 字符）。 */
export function idem(seed) {
  return `idem-${String(seed).padStart(4, '0')}`;
}

export function assertApiErrorShape(error, code, status) {
  if (!(error instanceof ApiError)) throw new Error(`应为 ApiError，实际：${String(error)}`);
  if (error.code !== code) throw new Error(`错误码应为 ${code}，实际 ${error.code}`);
  if (error.status !== status) throw new Error(`HTTP 状态应为 ${status}，实际 ${error.status}`);
}

export async function captureError(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('期望抛出错误，但没有抛出');
}

/** 把业务错误渲染成**逐字节可比**的契约错误封套（归属/不存在同形判定的核心工具）。 */
export function errorEnvelopeJson(error, requestId = '99999999-9999-4999-8999-999999999999', executionMode = 'stub') {
  if (!(error instanceof ApiError)) throw new Error(`应为 ApiError，实际：${String(error)}`);
  return JSON.stringify(buildErrorEnvelope(error, { request_id: requestId, execution_mode: executionMode }));
}

/** 脚本化时钟：`now()` 返回可控时刻，`advance(ms)` 手动推进。 */
export function scriptedClock(baseMs = Date.UTC(2026, 9, 14, 3, 0, 0)) {
  let ms = baseMs;
  return {
    now: () => new Date(ms),
    advance: (deltaMs) => {
      ms += deltaMs;
      return ms;
    },
    get ms() {
      return ms;
    },
  };
}

/**
 * **可控可见性替身**：`visible` 集合外的目标一律 `unavailable`。
 *
 * 用途：模拟"目标当前对该用户可见与否"（含隐藏/失效/删除/注销后不可读）。
 * 这是**替身**，不是真实可见性核验实现；它的存在只用于证明服务层在**每次读取**都重新问它。
 */
export function makeControllableVisibility(initialVisible = []) {
  const visible = new Set(initialVisible);
  const calls = [];
  const port = createWiredVisibilityPort({
    note: '测试替身：不可见的集合可由用例控制（不是真实可见性核验实现）',
    resolve: async ({ target_ref, userId }) => {
      const key = `${target_ref.type}:${target_ref.id}`;
      calls.push({ key, userId });
      return visible.has(key) ? 'available' : 'unavailable';
    },
  });
  return {
    port,
    calls,
    show: (type, id) => visible.add(`${type}:${id}`),
    hide: (type, id) => visible.delete(`${type}:${id}`),
    isVisible: (type, id) => visible.has(`${type}:${id}`),
  };
}

/** 抛错的可见性替身（用来验证 fail-closed：读取失败 ⇒ 不可用，且说明落在冻结闭集内）。 */
export function makeThrowingVisibility() {
  return createWiredVisibilityPort({
    resolve: async () => {
      throw new Error('合成故障：不可外传的原始错误文本');
    },
  });
}

/** 返回非闭集取值的可见性替身（`true` / 任意字符串都不算可用）。 */
export function makeJunkVisibility(value) {
  return createWiredVisibilityPort({ resolve: async () => value });
}

/**
 * **可控任务状态替身**：`states` 映射 `jobId → JobState`；未登记的 jobId 返回 `null`（核不到）。
 * 该替身同样是"替身/未验证"，只用于证明服务层读取时确实重查、且不会凭空升级为成功。
 */
export function makeControllableJobPort(initial = {}, options = {}) {
  const states = new Map(Object.entries(initial));
  const calls = [];
  const port = createWiredHistoryJobPort({
    note: '测试替身：任务状态可由用例控制（不是真实作业读取实现）',
    resolve: async ({ jobId, userId }) => {
      calls.push({ jobId, userId });
      if (options.throwFor !== undefined && options.throwFor === jobId) throw new Error('合成故障');
      const state = states.get(jobId);
      return state === undefined ? null : state;
    },
  });
  return {
    port,
    calls,
    set: (jobId, state) => states.set(jobId, state),
    forget: (jobId) => states.delete(jobId),
  };
}

/** 收藏域夹具。 */
export function makeFavoritesHarness(options = {}) {
  const clock = options.clock ?? scriptedClock();
  const store = options.store ?? createMemoryFavoritesStore({ now: () => clock.ms });
  const visibility = options.visibility ?? createUnwiredVisibilityPort();
  const service = createFavoritesService({
    store,
    visibility,
    signingKey: TEST_SIGNING_KEY,
    now: clock.now,
    newId: options.newId ?? makeIdFactory(options.namespace ?? '1'),
    ...(options.idempotencyWaitMs === undefined ? {} : { idempotencyWaitMs: options.idempotencyWaitMs }),
    ...(options.idempotencyTtlMs === undefined ? {} : { idempotencyTtlMs: options.idempotencyTtlMs }),
  });
  return { store, visibility, service, clock };
}

/** 历史域夹具。 */
export function makeHistoryHarness(options = {}) {
  const clock = options.clock ?? scriptedClock();
  const store = options.store ?? createMemoryHistoryStore({ now: () => clock.ms });
  const visibility = options.visibility ?? createUnwiredVisibilityPort();
  const job = options.job ?? createUnwiredHistoryJobPort();
  const cascade = options.cascade ?? createUnwiredHistoryCascadePort();
  const service = createHistoryService({
    store,
    visibility,
    job,
    cascade,
    signingKey: TEST_SIGNING_KEY,
    now: clock.now,
    newId: options.newId ?? makeIdFactory(options.namespace ?? '2'),
    ...(options.idempotencyWaitMs === undefined ? {} : { idempotencyWaitMs: options.idempotencyWaitMs }),
    ...(options.idempotencyTtlMs === undefined ? {} : { idempotencyTtlMs: options.idempotencyTtlMs }),
  });
  return { store, visibility, job, cascade, service, clock };
}

/** 便捷：经内部创建口落一条历史（返回 `{created, history}`）。 */
export async function appendHistory(service, overrides = {}) {
  return service.appendHistory({
    owner_id: USER_A.userId,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: '00000000-0000-4000-8a00-000000000001', revision: 1 },
    job_id: '00000000-0000-4000-8b00-000000000001',
    job_state: 'succeeded',
    event_key: 'evt-1',
    ...overrides,
  });
}
