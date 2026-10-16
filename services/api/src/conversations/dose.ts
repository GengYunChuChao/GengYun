/**
 * GY-I12（#12）· **用量卡的唯一权威路径**（确定性判定；本片没有真实模型）。
 *
 * 派单 §3 第 5 项要求「剂量卡只能取自确定性权威路径」。仓库里那条路径是 GY-I08 的
 * `doseCardDescriptor`（`packages/reference`，规则版本 `APPLICABILITY_RULE_VERSION`）；
 * 本文件是会话域**唯一**的调用点，因此：
 *
 *  1. **不重写规则、不自建第二套命中逻辑**：判定完全交给域库，本层只做两件事 ——
 *     把条目原样交进去、把 `renderable === false` 如实翻译成「拒绝」。
 *  2. **默认不放行**：描述子抛错、返回值形状不对、或 `renderable !== true` ⇒ 一律
 *     `renderable:false` + 明示原因。**绝不**因为"拿不到判定结果"就默认可以出卡。
 *  3. **功能开关不当作借口**：这里固定以 `doseCardEnabled: true` 询问，也就是说
 *     拒绝的原因必须是**资料本身**没有可用作依据的用量字段，而**不是**"我们把功能关了"。
 *     这样"资料不足"与"功能关闭"在理由串上可区分（`FEATURE_CLOSED` 只会在真的关闸时出现）。
 *  4. `rule_version` 由域库提供，本域**不猜**：`createDeterministicDoseAuthority().ruleVersion`
 *     直接取 `APPLICABILITY_RULE_VERSION`，供 `Answer.rule_version` 使用。
 *
 * 本基线的事实（已实测，见交接 §自证）：`packages/knowledge` 的登记证记录 `dose_text` 为
 * `null`、`usable_as_dose` / `card_ready` 为 `false`，且读面投影根本没有用量列 ⇒
 * 描述子对任何条目都返回 `renderable:false`，理由为「本记录未采集可用作依据的用量字段」。
 * 于是本片**结构上不可能**产出用量卡 —— 这正是"可如实判定"的含义。
 */
import { APPLICABILITY_RULE_VERSION, doseCardDescriptor } from '../../../../packages/reference/index.mjs';
import type { DoseAuthority, RetrievalItem } from './guard.ts';

/** 本域用量卡权威路径的自述（进 `DoseAuthority.note`，供交接与回归用例引用）。 */
export const DOSE_AUTHORITY_NOTE = `确定性用量判定（域库 doseCardDescriptor，规则 ${APPLICABILITY_RULE_VERSION}）：本片未接真实模型，未取得判定通过前不产出任何用量卡`;

export interface DeterministicDoseAuthority extends DoseAuthority {
  /** 域库自报的规则版本（`Answer.rule_version` 的事实来源，本域不猜）。 */
  readonly ruleVersion: string;
}

/**
 * 装配确定性用量权威。
 *
 * @param options.doseCardEnabled 询问描述子时的功能开关；**默认 true**（见文件头第 3 条）。
 */
export function createDeterministicDoseAuthority(
  options: { doseCardEnabled?: boolean } = {},
): DeterministicDoseAuthority {
  const doseCardEnabled = options.doseCardEnabled ?? true;
  return {
    kind: 'wired',
    note: DOSE_AUTHORITY_NOTE,
    available: true,
    ruleVersion: APPLICABILITY_RULE_VERSION,
    authorize({ item }: { item: RetrievalItem; question: string; conditions: Record<string, unknown> | null }) {
      let verdict: { renderable: boolean; reason: string | null; rule_version: string };
      try {
        verdict = doseCardDescriptor(item.raw, { doseCardEnabled });
      } catch (error) {
        // 判定本身失败 ⇒ 拒绝（`renderable:false`），并把原因如实写出来。
        const message = error instanceof Error ? error.message : String(error);
        return { renderable: false, reason: `dose_descriptor_failed:${message.slice(0, 120)}` };
      }
      if (verdict === null || typeof verdict !== 'object' || verdict.renderable !== true) {
        // 形状不对（拿不到判定）也拒绝；有理由就照抄域库的理由，没有就明说没有。
        const reason =
          verdict !== null && typeof verdict === 'object' && typeof verdict.reason === 'string' && verdict.reason.length > 0
            ? verdict.reason
            : 'dose_not_renderable';
        return { renderable: false, reason };
      }
      // 走到这里说明域库判定该条目可渲染。**仍然**只报告"可渲染"这个事实，
      // 卡片正文由调用方按域库描述子产出；本层不代替域库拼卡片。
      return { renderable: true, reason: `dose_renderable:${verdict.rule_version}` };
    },
  };
}
