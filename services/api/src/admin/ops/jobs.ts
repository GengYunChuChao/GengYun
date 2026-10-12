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
import { TERMINAL_JOB_STATES } from './types.ts';
import type { AdminJobPort, AdminJobView, CancelJobOutcome } from './types.ts';

/** 默认端口：未接线。fail-closed 的单一来源。 */
export function createUnwiredAdminJobPort(): AdminJobPort {
  return Object.freeze({
    wired: false,
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
    list() {
      return [...jobs.values()]
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
