/**
 * GY-I15（#15）阶段 2 · 帖子「杂草／药剂关联」可用性端口（契约 `KnowledgeLink` 的唯一来源）。
 *
 * ## 契约语义（`packages/contracts/openapi.json`，逐字）
 *
 * `Post.linked_knowledge` 说明：「关联不可用只保留目标 ref 和粗粒度状态」；
 * `PostInput.linked_knowledge_ref` 说明：「创建遗漏关联等于无关联；编辑遗漏关联保留旧值，
 * 显式 null 解除关联。**新增/替换引用需当前可用**，原已保存失效引用可原样保留，
 * 但只输出不可用投影。」
 *
 * 因此本端口只回答两件事，且都必须**逐次现查**（不缓存、不落库）：
 *   1. 该 `KnowledgeTarget` **当前**是否可用（供"新增/替换引用"这道闸）；
 *   2. 该引用的**当前投影**（`reference_state` / `unavailable_reason` / `summary`）。
 *
 * ## 为什么"只取有效可访问非模拟资料"
 *
 * 契约 `SourceRef` 把来源分为 `database` / `verified_seed` / `simulation` 三类，并把
 * `validity`（`valid`/`expired`/`conflicting`/`unknown`/`withdrawn`）与
 * `review_status`（`unverified`/`verified`/`rejected`）逐行投影。
 * 社区帖子挂在用户可见的正文旁，因此**只有**下面三条同时成立才判 `available`：
 *   - `reference_state === 'available'`（资料自身当前有效）；
 *   - `source.validity === 'valid'`（不是过期/冲突/撤回/未知）；
 *   - `source.review_status === 'verified'`（**已核对**；`unverified` 与 `rejected` 一律不可用）；
 *   - `source.source_kind !== 'simulation'`（**模拟资料一律不作为关联依据**）。
 * 这条比 `/knowledge` 列表页的口径更严：列表页允许标注 `unverified` 并展示，
 * 而"挂到一条公开帖子上当依据"必须是已核对且非模拟的资料。
 *
 * ## fail-closed（本片默认）
 *
 * 默认端口 `createUnwiredKnowledgeAvailabilityPort()`：**一律 `unavailable`**，
 * 且 `createPost`/`editPost` 在"新增/替换引用"时直接拒绝（`OBJECT_UNAVAILABLE`），
 * 绝不静默丢弃关联（契约：「创建遗漏关联等于无关联」，静默丢弃会让客户端以为关联已保存）。
 *
 * 真实接线（`createKnowledgeAvailabilityPort()`)由**装配层**完成：`services/api/src/app.ts` 在**有连接池**时
 * 用**同一条 `pool`** 查公开读视图 `catalog_read.current_knowledge`（已发布 + 来源已核对 + 当前生效 + 非模拟；
 * 与 `/knowledge` 同一张视图）构造读取闭包；**无池**时保持本文件的未接线端口（fail-closed，不假装可用）。
 * 本模块不 import 资料域，只依赖结构性端口（仓库既有分层：特征域不互相 import）。
 */
import type { KnowledgeTarget, KnowledgeLinkSummary } from './types.ts';

/** 契约 `ReferenceState` 闭集（`packages/contracts/states.json`）。 */
export type ReferenceState = 'available' | 'unavailable';

/** 契约 `KnowledgeLink`（`summary` 只有 `title`）。 */
export interface KnowledgeLinkProjection {
  target_ref: KnowledgeTarget;
  reference_state: ReferenceState;
  unavailable_reason: 'TARGET_UNAVAILABLE' | null;
  summary: KnowledgeLinkSummary | null;
}

export interface KnowledgeAvailabilityPort {
  /** 接线状态：`false` 时服务层**必须**把一切引用判为不可用。 */
  readonly wired: boolean;
  /** 如实标注，供证据文档与诊断引用。 */
  readonly note: string;
  /** 逐次现查当前可用性与投影；**不得**返回缓存结果。 */
  lookup(target: KnowledgeTarget): Promise<KnowledgeLinkProjection>;
}

/** 统一的不可用投影（不泄露资料是否存在、不区分"未接线"与"不存在"）。 */
export function unavailableLink(target: KnowledgeTarget): KnowledgeLinkProjection {
  return {
    target_ref: { type: target.type, id: target.id, revision: target.revision },
    reference_state: 'unavailable',
    unavailable_reason: 'TARGET_UNAVAILABLE',
    summary: null,
  };
}

/** 未接线端口（默认）：一律不可用 ⇒ "新增/替换引用"一律被拒，绝不静默丢弃。 */
export function createUnwiredKnowledgeAvailabilityPort(
  reason = '资料可用性读取端口尚未接线（本片未提供会话域资料读取适配器）',
): KnowledgeAvailabilityPort {
  return {
    wired: false,
    note: `${reason}（fail-closed：一律 unavailable，不假装可用、不回退替身、不用模拟资料）`,
    async lookup(target) {
      return unavailableLink(target);
    },
  };
}

export interface WiredKnowledgeAvailabilityOptions {
  /**
   * 资料读取实现。返回值**被规范化**：任何形状异常、抛错、字段不符（含
   * `id`/`type`/`revision` 与目标不一致）一律折叠为 `unavailable`。
   */
  read(target: KnowledgeTarget): Promise<unknown>;
  note?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 已接线端口：把资料域返回值**规范化**为契约 `KnowledgeLink`。
 *
 * 只有下列条件**全部**成立才判 `available`（否则 `unavailable` + `TARGET_UNAVAILABLE`）：
 *   - 返回对象是资料行，且 `id` / `type` / `revision` 与请求目标**逐项一致**（防串资料）；
 *   - `reference_state === 'available'`；
 *   - `source.validity === 'valid'`；
 *   - `source.review_status === 'verified'`（未核对/已拒绝一律不可用）；
 *   - `source.source_kind !== 'simulation'`（模拟资料不得作为关联依据）；
 *   - `title` 是非空字符串（`KnowledgeLinkSummary.title` 1..200）。
 */
export function createKnowledgeAvailabilityPort(
  options: WiredKnowledgeAvailabilityOptions,
): KnowledgeAvailabilityPort {
  return {
    wired: true,
    note:
      options.note ??
      '资料可用性端口已接线：逐次现查；只认已核对（review_status=verified）且有效（validity=valid）的非模拟资料',
    async lookup(target) {
      let row: unknown;
      try {
        row = await options.read(target);
      } catch {
        // 读取失败属于"当前不可用"，不是 500，也不得变成"默认可用"。
        return unavailableLink(target);
      }
      if (!isPlainObject(row)) return unavailableLink(target);
      if (row['id'] !== target.id) return unavailableLink(target);
      if (row['type'] !== target.type) return unavailableLink(target);
      const revision = row['revision'];
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
        return unavailableLink(target);
      }
      if (revision !== target.revision) return unavailableLink(target);
      if (row['reference_state'] !== 'available') return unavailableLink(target);
      const source = row['source'];
      if (!isPlainObject(source)) return unavailableLink(target);
      if (source['validity'] !== 'valid') return unavailableLink(target);
      if (source['review_status'] !== 'verified') return unavailableLink(target);
      if (source['source_kind'] === 'simulation') return unavailableLink(target);
      const title = row['title'];
      if (typeof title !== 'string' || title.length === 0 || title.length > 200) return unavailableLink(target);
      return {
        target_ref: { type: target.type, id: target.id, revision: target.revision },
        reference_state: 'available',
        unavailable_reason: null,
        summary: { title },
      };
    },
  };
}
