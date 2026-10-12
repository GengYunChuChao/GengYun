/**
 * 审计事件日志（GY-I18 阶段 1）：**只可追加，不可改、不可删**。
 *
 * 契约 `components.schemas.AuditEvent`（additionalProperties:false，8 个必填字段）：
 *   id / action / scope / target_ref / reason_code / request_id / result / created_at
 *
 * 契约缺口（如实记录，不自行补字段）：这 8 个字段里**没有主体/actor**，
 * 而派单要求审计事件「含主体、动作、目标 TargetRef（含 revision）、时间」。
 * 因此：
 * - 内部记录 = 契约 8 字段 **+ `actor_id`**（主体）；内部记录同样只可追加。
 * - `projectAuditEvent()` 是**唯一的契约出口**，严格只输出合同的 8 个字段。
 *
 * 「不可改删」的实现与可验证性：
 * - 模块**只导出** `append` / `list` / `count` / `projectAuditEvent` / `auditLogSurface`，
 *   没有任何 update / delete / remove / clear / splice 入口；
 * - 每条记录与 `target_ref` 都 `Object.freeze` 深冻结，产出即不可变；
 * - `list()` 每次返回**新的冻结数组**，调用方拿到的是副本，改不动内部状态。
 */
import { randomUUID } from 'node:crypto';
import { assertContractInput } from './fields.ts';
import type { AuditRecord, AuditResult, ContractAuditEvent, TargetRefValue } from './types.ts';

export interface AuditAppendInput {
  actorId: string;
  action: string;
  scope: string;
  targetRef: TargetRefValue | null;
  reasonCode: string;
  requestId: string;
  result: AuditResult;
  createdAt: Date;
  /** 仅测试注入固定 id 时使用；缺省生成 uuid。 */
  id?: string;
}

export interface AuditLog {
  /** 追加一条记录并返回其冻结副本。 */
  append(input: AuditAppendInput): AuditRecord;
  /** 按 created_at 升序（同刻按追加次序）读取全部记录，返回冻结副本数组。 */
  list(): readonly AuditRecord[];
  /** 记录条数。 */
  count(): number;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * 契约出口：把内部记录投影成契约 `AuditEvent`。
 * 只取合同的 8 个字段；内部独有的 `actor_id` 在此被剥离。
 */
export function projectAuditEvent(record: AuditRecord): ContractAuditEvent {
  return {
    id: record.id,
    action: record.action,
    scope: record.scope,
    target_ref: record.target_ref === null ? null : { type: record.target_ref.type, id: record.target_ref.id, revision: record.target_ref.revision },
    reason_code: record.reason_code,
    request_id: record.request_id,
    result: record.result,
    created_at: record.created_at,
  };
}

/** 内存审计日志。进程内实现，**非**真实 PG 接线。 */
export function createAuditLog(): AuditLog {
  const entries: { record: AuditRecord; order: number }[] = [];
  let order = 0;

  return {
    append(input) {
      const record: AuditRecord = {
        id: input.id ?? randomUUID(),
        actor_id: input.actorId,
        action: input.action,
        scope: input.scope,
        target_ref: input.targetRef === null ? null : { type: input.targetRef.type, id: input.targetRef.id, revision: input.targetRef.revision },
        reason_code: input.reasonCode,
        request_id: input.requestId,
        result: input.result,
        created_at: input.createdAt.toISOString(),
      };
      // 入库前用契约镜像再校验一次：任何超长/闭集外取值都不允许落进审计台账。
      assertContractInput('AuditEvent', projectAuditEvent(record));
      deepFreeze(record);
      entries.push({ record, order });
      order += 1;
      return record;
    },
    list() {
      const sorted = [...entries].sort((left, right) => {
        const byTime = Date.parse(left.record.created_at) - Date.parse(right.record.created_at);
        return byTime !== 0 ? byTime : left.order - right.order;
      });
      return Object.freeze(sorted.map((entry) => entry.record));
    },
    count() {
      return entries.length;
    },
  };
}

/**
 * 审计模块的对外表面（供测试断言"没有改删入口"）。
 * 有意保持极小的闭集：新增任何写口都会让该断言失败。
 */
export const auditLogSurface: readonly string[] = Object.freeze(['append', 'list', 'count']);
