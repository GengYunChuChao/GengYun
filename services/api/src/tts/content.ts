/**
 * GY-I13 普通话 TTS 合成域 · 「已核对内容」读取端口。
 *
 * 本域**不接受**任何自由文本入参：`SynthesisInput` 只有一个 `checked_content_ref`，
 * 因此服务端必须自己把「这个目标当前是否经核对通过、当前 revision 是多少、正文是什么」
 * 读出来，再交给 `state.ts` 的 `decideCheckedContent` 判定。本文件只提供这条读取边。
 *
 * 安全口径（与 state.ts 的判定互补）：
 * - 端口**只读**：没有写入口，TTS 域不能修改核对状态、不能「顺手」把内容标成已核对。
 * - 端口返回 `null` = 内容不存在／不可见（→ 404 NOT_FOUND）；
 *   端口**抛错** = 取不到核对状态（→ 409 OBJECT_UNAVAILABLE，绝不当作 approved）。
 * - 端口如实透出 `auditState` / `text`（声明为 `unknown`）：未知状态值由判定层拒绝，
 *   端口不得自行把未知值规整成 `approved`。
 *
 * 现状（如实记录）：
 * - 服务端**没有**真实的已核对内容读取实现，也没有对应的契约读端点；本片提供
 *   「明确标注的替身核对源」（合成条目，非真实资料库）供离线联调与回归，
 *   以及「未接线」实现（`real` 模式）：读一律抛出 ⇒ 取不到核对状态 ⇒ 一律拒绝。
 * - 因此在本片，`real` 模式的合成路径**必然 fail-closed**（提供者缺凭据 + 核对源未接线），
 *   这是刻意选择：宁可拒绝，也不「照文本念」。真实核对源接线属阶段 2／后续任务。
 */

import type { CheckedContentSnapshot, SynthesisTargetType } from './state.ts';

/** 「取不到核对状态」：由未接线端口或读取失败抛出；判定层一律按不可用拒绝。 */
export class CheckedContentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckedContentUnavailableError';
  }
}

export interface CheckedContentPort {
  /** 端口类型：substitute=明确标注的替身核对源、unwired=未接线（fail-closed）。 */
  readonly kind: 'substitute' | 'unwired';
  /** 供证据文档／诊断引用的如实标注（不含任何资料正文或个人信息）。 */
  readonly note: string;
  /**
   * 读取该目标当前的核对快照。
   * @returns 快照（可能携带未知 auditState，由判定层拒绝）；`null` = 不存在／不可见。
   * @throws CheckedContentUnavailableError 取不到核对状态（未接线或读取失败）。
   */
  read(input: { type: string; id: string }): Promise<CheckedContentSnapshot | null>;
}

const SUBSTITUTE_NOTE =
  '替身核对源（stub/preset_demo）：条目是**合成**的，非真实资料库、非真实审核结论；只用于离线联调与回归，不构成任何内容已核对的证据。';

/** 替身核对源的条目（刻意允许非法 `auditState`，以证明「取不到核对状态 ⇒ 拒绝」）。 */
export interface SubstituteCheckedContentEntry {
  type: SynthesisTargetType;
  id: string;
  revision: number;
  /** 期望 AuditState；传入未知值用于构造「取不到核对状态」的反例。 */
  auditState: unknown;
  /** 归属：省略 = 平台／运营公共内容（null）。 */
  ownerUserId?: string | null;
  /** 已核对正文；省略 = 取不到正文（构造「核对通过但无可朗读正文」的反例）。 */
  text?: unknown;
}

/**
 * 替身核对源：按 (type, id) 查条目；查不到返回 `null`（→ 404）。
 * 明确标注为替身，且**不做任何状态规整**（未知值原样透出）。
 */
export function createMemoryCheckedContentPort(entries: readonly SubstituteCheckedContentEntry[] = []): CheckedContentPort {
  const table = new Map<string, SubstituteCheckedContentEntry>();
  for (const entry of entries) table.set(`${entry.type}\u0000${entry.id}`, entry);
  return {
    kind: 'substitute',
    note: SUBSTITUTE_NOTE,
    async read({ type, id }) {
      const entry = table.get(`${type}\u0000${id}`);
      if (entry === undefined) return null;
      return {
        type: entry.type,
        id: entry.id,
        revision: entry.revision,
        auditState: entry.auditState,
        ownerUserId: entry.ownerUserId ?? null,
        text: entry.text,
      };
    },
  };
}

/**
 * 未接线核对源（`real` 模式）：**没有**可核验的已核对内容来源，
 * 因此一次读取都不放行——抛 `CheckedContentUnavailableError`，由判定层映射为
 * 409 `OBJECT_UNAVAILABLE`（取不到核对状态），而不是退回 404 假装内容不存在。
 */
export function createUnwiredCheckedContentPort(
  reason = '真实已核对内容来源尚未接线，无法确认核对状态',
): CheckedContentPort {
  return {
    kind: 'unwired',
    note: `${reason}（fail-closed：取不到核对状态即拒绝合成）`,
    async read() {
      throw new CheckedContentUnavailableError(reason);
    },
  };
}

/** 按执行模式选择核对源：只有替身模式才允许替身条目。 */
export function createCheckedContentPort(
  executionMode: string,
  entries: readonly SubstituteCheckedContentEntry[] = [],
): CheckedContentPort {
  return executionMode === 'real' ? createUnwiredCheckedContentPort() : createMemoryCheckedContentPort(entries);
}
