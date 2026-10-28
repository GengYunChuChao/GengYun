/**
 * 审计事件日志（GY-I18 阶段 1）：**只可追加，不可改、不可删**。
 *
 * 契约 `components.schemas.AuditEvent`（additionalProperties:false，8 个必填字段）：
 *   id / action / scope / target_ref / reason_code / request_id / result / created_at
 *
 * 契约缺口：这 8 个**必填**字段里没有主体/actor；R29-S5 只把它加成**可选可空**的
 * `actor`，别当必填用。主体信息今天由 `actor_id` ＋ `scope` ＋ `result`／`reason_code` 表达。
 * 因此（权限只由 `scope` 表达，**不新增 role 列**）：
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
import { freezeDeep } from './immutable.ts';
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
  /**
   * **内部专用**的目标标识（阶段 1b 新增）。
   *
   * 起因（契约缺口）：`TargetRef.type` 的 17 个闭集成员里**没有** category / account / flag，
   * 而契约又允许 `target_ref: null`。若只写 null，审计就丢掉了"改的是哪一个目标"。
   * 因此把目标标识放在**内部记录**上；契约投影（`projectAuditEvent`）严格只输出合同的 8 个字段，
   * `target_hint` 永不出现在响应里。
   */
  targetHint?: string | null;
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
  // 与 `immutable.ts` 共用同一份实现，避免两处冻结语义分叉。
  return freezeDeep(value);
}

/**
 * 契约出口：把内部记录投影成契约 `AuditEvent`。
 * 只取合同的 8 个字段；内部独有的 `actor_id` 在此被剥离。
 *
 * 出口安全：这里**构造全新的标量对象**，不引用任何内部可变结构，
 * 因此审计出口天然是副本（`AuditEvent` 全部字段都是 string / enum / 嵌套标量）。
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
        target_hint: input.targetHint ?? null,
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
