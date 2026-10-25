/**
 * GY-I18 阶段 1b · 平台级作业端口（`AdminJobPort`）。
 *
 * 现实约束（派单第 3 条）：`#9/#10/#11/#13` 产生的平台级 job 目前**没有共享读面/取消面**
 * ——那是另一张工单（等 #87 合并）。因此本片**只定义端口**，并提供：
 *   1. `createUnwiredAdminJobPort()`：**默认无实现**。`wired === false`，
 *      `list()` 空、`get()` null、`cancel()` 一律 `PORT_UNAVAILABLE`。
 *      服务层据此对读与写**一律 503 `PROVIDER_UNAVAILABLE`**：
 *      返回空页会被读成"平台当前没有作业"，那是我们**无法确认**的结论（伪造）。
 *   2. `createMemoryAdminJobPort(seed)`：**参考实现**（接线用 + 测试用）。
 *      只暴露 `seed` 里给的作业，**不会自己凭空造作业**；取消走 CAS，
 *      **终态不可复活**（与 `states.json.job_transitions` 的守卫一致）。
 */
import { cloneDeep, freezeDeep } from '../immutable.ts';
import { ApiError } from '../../errors.ts';
import { ERROR_CODES } from '../../contract.ts';
import { JOB_STATES, TERMINAL_JOB_STATES } from './types.ts';
import type { AdminJobFilter, AdminJobPort, AdminJobView, CancelJobOutcome } from './types.ts';

/**
 * 闭集参数的唯一判定点：`state`（契约 `JobState` 7 值）与 `error_code`（契约 `ErrorCode` 24 值）。
 *
 * 口径与 `admin/audit/service.ts` 的 `action`/`entity` 逐条一致：
 * - 缺省 / `null` / **空串** ⇒ 该字段不参与过滤（`?state=` 不该变成闭集外的 400）；
 * - 非字符串（`?state=a&state=b` 会被查询串解析成数组）⇒ **400 `INVALID_REQUEST`**、`code: 'type'`；
 * - 闭集外取值（含大小写不同、拼写错误）⇒ **400 `INVALID_REQUEST`**、`code: 'enum'`。
 *
 * ⛔ 不复用 503：`PROVIDER_UNAVAILABLE` 的含义是"端口未接线"或"读出来的值我们不认识"，
 * 而这里错在**调用方入参**，属 400。⛔ 也不静默返回空页 —— 那会把拼错的状态说成
 * "平台没有这种作业"，是一句我们无法确认的结论。
 */
function parseClosedSetParam<T extends string>(
  raw: unknown,
  field: string,
  closed: readonly T[],
): T | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new ApiError('INVALID_REQUEST', `${field} 必须是字符串`, {
      details: [{ field, code: 'type' }],
    });
  }
  if (!(closed as readonly string[]).includes(raw)) {
    throw new ApiError('INVALID_REQUEST', `${field} 必须是闭集之一：${closed.join(' / ')}`, {
      details: [{ field, code: 'enum' }],
    });
  }
  return raw as T;
}

/**
 * `listAdminJobs` 的过滤入参 → 已判定的闭集过滤。
 * 缺省的字段**不出现在**结果里（读面据此决定要不要下推 `WHERE`）。
 */
export function parseAdminJobFilter(raw: { state?: unknown; error_code?: unknown }): AdminJobFilter {
  const state = parseClosedSetParam(raw.state, 'state', JOB_STATES);
  const errorCode = parseClosedSetParam(raw.error_code, 'error_code', ERROR_CODES);
  const filter: AdminJobFilter = {};
  if (state !== null) filter.state = state;
  if (errorCode !== null) filter.error_code = errorCode;
  return filter;
}

/** 过滤是否为空（两个字段都没给）⇒ 读面必须给出与"不过滤"逐字相同的读面语句。 */
export function isEmptyAdminJobFilter(filter: AdminJobFilter): boolean {
  return filter.state === undefined && filter.error_code === undefined;
}

/** 内存参考实现的匹配（真实现是 SQL `WHERE`，这里是同一语义的进程内等价物）。 */
function matchesAdminJobFilter(job: AdminJobView, filter: AdminJobFilter): boolean {
  if (filter.state !== undefined && job.state !== filter.state) return false;
  if (filter.error_code !== undefined && job.error_code !== filter.error_code) return false;
  return true;
}

/** 默认端口：未接线。fail-closed 的单一来源。 */
export function createUnwiredAdminJobPort(): AdminJobPort {
  return Object.freeze({
    wired: false,
    // 进程内端口：没有库事务，取消与审计都不落库（服务层据此自己写内存审计流）。
    persistent: false,
    list: () => [],
    get: () => null,
    cancel: (): CancelJobOutcome => ({ ok: false, reason: 'PORT_UNAVAILABLE' }),
  });
}

/**
 * 参考实现：由 `seed` 提供的作业集合（不凭空生成）。
 * 取消语义：只允许 `queued` / `running` → `cancelled`，且必须 revision 匹配；
 * 终态一律 `TERMINAL`，**永不复活**。
 */
export function createMemoryAdminJobPort(seed: readonly AdminJobView[] = []): AdminJobPort & {
  snapshot(): AdminJobView[];
} {
  const jobs = new Map<string, AdminJobView>();
  for (const job of seed) {
    // 入参也要过不可变边界：存的是自己的冻结副本，外部持有者改不动。
    jobs.set(job.id, freezeDeep(cloneDeep(job)));
  }

  const clone = (job: AdminJobView): AdminJobView => cloneDeep(job);

  return {
    wired: true,
    // 参考实现只改进程内 `Map`：没有库事务 ⇒ `cancel()` 的 `audit` 入参被忽略，
    // 审计由服务层写既有内存 `store.audit.append`（stub 模式口径逐字不变）。
    persistent: false,
    list(filter: AdminJobFilter = {}) {
      // 端口边界再判一次闭集：端口也会被直接调用（集成测试/单测），非法入参一律 400，
      // 绝不静默返回空页。内存实现没有 SQL，所以匹配在进程内做（见 `matchesAdminJobFilter`）。
      const applied = parseAdminJobFilter(filter);
      return [...jobs.values()]
        .filter((job) => matchesAdminJobFilter(job, applied))
        .map(clone)
        .sort((a, b) => {
          if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
          return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
        });
    },
    get(id) {
      const job = jobs.get(id);
      return job === undefined ? null : clone(job);
    },
    cancel(id, expectedRevision): CancelJobOutcome {
      const current = jobs.get(id);
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' };
      // 终态是单向门：`succeeded`/`uncertain`/`failed`/`timed_out`/`cancelled` 不可再迁移。
      if (TERMINAL_JOB_STATES.includes(current.state)) return { ok: false, reason: 'TERMINAL' };
      if (current.revision !== expectedRevision) return { ok: false, reason: 'REVISION_CHANGED' };
      const next = freezeDeep(
        cloneDeep({ ...current, state: 'cancelled' as const, revision: current.revision + 1 }),
      );
      jobs.set(id, next);
      return { ok: true, job: clone(next) };
    },
    snapshot() {
      return [...jobs.values()].map(clone);
    },
  };
}
