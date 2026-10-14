/**
 * GY-I09 **用户选择独立记录**（issue #9 范围第 3 条）：
 * 「用户选择独立记录，关联科普及条件完整后查询，保存私有历史」。
 *
 * 硬规则（派单 + 验收逐条落实）：
 *   1. **候选与人工选择分开记录**：模型原始候选写在 `Recognition.candidates`
 *      （契约冻结形状），人工选择写成本模块的**独立记录行** —— 两者各有自己的 id/revision，
 *      人工选择**绝不回写** `candidates` / `model_score` / `model_version`。
 *   2. **append-only**：同一识别记录被再次选择时**追加**一条新记录（不覆盖历史），
 *      因此「谁在什么时候改选了什么」可完整追溯，也便于与 #16 的用户端历史对齐。
 *   3. **不得把手改/预设算成模型准确率**：每条记录带 `provenance`，且
 *      `MODEL_ATTRIBUTABLE_PROVENANCE` **恒为空集** —— 任何来源（用户点选、人工核对覆盖、
 *      预设演示）都不具备「模型成绩」资格；`countModelAttributable()` 因此**恒为 0**。
 *      这使「手改/预设混进准确率」在类型与运行期都无从发生，而不是靠文档约定。
 *   4. **归属私有**：记录带 `ownerUserId`，读取一律经归属守卫（越权与不存在同形 404）。
 *
 * 边界（与 #16 的分工）：
 *   本模块**不是**收藏/历史模块，**不注册任何契约 operation**，也**不提供页面**。
 *   它是识别域内部的记录形状；用户端「历史/收藏」由 #16（`/history`、`/favorites`）负责。
 *   `Recognition → 历史` 的写入接线属**跨线待接线点**（待 #16 的内部口进入 main 后补齐）。
 */

import type { SelectionLinkage } from './linkage.ts';

/**
 * 选择来源闭集。
 *
 * `human` —— 用户点选候选或人工核对确认（本片唯一实际写入的来源）；
 * `manual_override` —— 用户手改了模型给出的结论（同样是**人工**，不是模型成绩）；
 * `preset_demo` —— 演示预设（**明确标注替身**，绝不算模型成绩）。
 */
export const SELECTION_PROVENANCE = ['human', 'manual_override', 'preset_demo'] as const;
export type SelectionProvenance = (typeof SELECTION_PROVENANCE)[number];

/** 面向用户的来源标签（不作绝对承诺）。 */
export const SELECTION_PROVENANCE_LABELS: Readonly<Record<SelectionProvenance, string>> = Object.freeze({
  human: '用户选择',
  manual_override: '用户人工修正',
  preset_demo: '预设演示（非真实识别）',
});

/**
 * 有资格计入**模型成绩**的来源集合 —— **恒为空**。
 *
 * 这是本片对「不得把手改/预设算成模型准确率」的**机器可断言**表述：
 * 没有一种「用户选择来源」可以进入模型成绩；模型成绩只能来自
 * 独立样本上的模型原始输出（交 GY-I21，见需求第 6 节），而不是本模块记录的任何一行。
 */
export const MODEL_ATTRIBUTABLE_PROVENANCE: readonly SelectionProvenance[] = Object.freeze([]);

export function isSelectionProvenance(value: unknown): value is SelectionProvenance {
  return typeof value === 'string' && (SELECTION_PROVENANCE as readonly string[]).includes(value);
}

/** 该来源是否可计入模型成绩（对闭集内**所有**成员恒 false）。 */
export function isModelAttributable(provenance: SelectionProvenance): boolean {
  return (MODEL_ATTRIBUTABLE_PROVENANCE as readonly string[]).includes(provenance);
}

/** 识别记录的**人工选择**独立行（域内形状；不进任何契约封套）。 */
export interface SelectionRecord {
  id: string;
  revision: number;
  /** 被选择的识别记录 id（1:1 归属；同一记录可有多行 = 改选历史）。 */
  recognitionId: string;
  /** 归属者：私有，读取必须同主体。 */
  ownerUserId: string;
  /** 人工选定的品种 id（契约 `selected_species_id` 同一字段口径 1..80）。 */
  speciesId: string;
  /** 来源（恒 `human`；`manual_override` / `preset_demo` 保留给显式标注场景）。 */
  provenance: SelectionProvenance;
  /** 选择时刻（服务端时钟）。 */
  decidedAt: Date;
  /**
   * 选择时解析的**关联科普与条件**结果（有效/可访问/非模拟资料 + GY-I08 用量守卫判定）。
   * 与模型候选**完全分离**：这里没有任何候选分数。
   */
  linkage: SelectionLinkage;
}

/** 人工选择的汇总（供证据与诊断；**不含**任何模型成绩口径）。 */
export interface SelectionSummary {
  /** 记录行数（含改选历史）。 */
  total: number;
  /** 按来源分组的行数。 */
  by_provenance: Record<SelectionProvenance, number>;
  /**
   * 可计入模型成绩的行数 —— **恒 0**（来源闭集与模型成绩无交集）。
   * 该字段存在的意义是：让「手改/预设不得计入」成为**被断言的值**，而不是口头约定。
   */
  model_attributable: 0;
  /** 最近一次选择时刻（无记录时 null）。 */
  last_decided_at: string | null;
}

/** 汇总一组人工选择记录（纯函数，确定性）。 */
export function summarizeSelections(records: readonly SelectionRecord[]): SelectionSummary {
  const byProvenance: Record<SelectionProvenance, number> = { human: 0, manual_override: 0, preset_demo: 0 };
  let last: Date | null = null;
  let attributable = 0;
  for (const record of records) {
    byProvenance[record.provenance] += 1;
    if (isModelAttributable(record.provenance)) attributable += 1;
    if (last === null || record.decidedAt.getTime() > last.getTime()) last = record.decidedAt;
  }
  return {
    total: records.length,
    by_provenance: byProvenance,
    // 断言：可计入模型成绩的行数**恒为 0**（来源闭集与模型成绩无交集）。
    model_attributable: attributable === 0 ? 0 : (() => {
      throw new Error('内部不变量被打破：人工/预设选择被计入了模型成绩');
    })(),
    last_decided_at: last === null ? null : last.toISOString(),
  };
}
