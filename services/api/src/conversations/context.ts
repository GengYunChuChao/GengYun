/**
 * GY-I12（#12）· **会话上下文端口**（追问上下文：只取自本会话、只属于本主体）。
 *
 * 派单 §1 第 1 项与 issue 范围①的「保存引用…**及会话上下文**」：同一会话里的追问要能看到
 * 本会话**之前**轮次的提问，而**不能**看到别的会话、更不能看到别人的会话。本文件是这条语义的
 * **唯一来源**，回答管线只从这里的端口取上下文（不自行拼历史、不缓存、不跨域读）。
 *
 * 三道硬约束（回归用例逐条锁住）：
 *  1. **归属**：`read()` 必须同时带 `conversationId` 与 `ownerId`，两者都由 store 的读方法
 *     逐行过滤（内存实现 `owner_id !== ownerId` 即 null，PG 实现 `WHERE owner_id = $n`）。
 *     别人的会话读不到 ⇒ 上下文恒为空，与"不存在"同形。
 *  2. **会话隔离**：只读 `conversation_id === conversationId` 的轮次。同一主体在两个不同会话里
 *     的提问互不可见 —— 跨会话不串，不是靠调用方自觉，而是靠本文件唯一的 `listTurns` 过滤条件。
 *  3. **有界 + 不含本轮**：最多 `CONTEXT_MAX_TURNS` 轮、按时间正序、且**排除本轮**（本轮在
 *     结算前仍是 `running`，把它当"上文"会让同一句话被算两次）。上限是语义的一部分：上下文
 *     不得随会话长度无界增长（否则既不可审计，也会把老提问悄悄拖进新回答）。
 *
 * 为什么上下文**只**进回答器、不进检索：本片没有真实模型，追问改写（把"那这个用量呢"补全成
 * 完整提问）属真实模型/供应商范围（**未取得**）。因此检索集合与引用仍**只按本问**决定，
 * 上下文只用于让回答器如实标注"这是本会话内的追问"，绝不借上下文扩大引用集合。
 */
import type { AnswerStatus } from './types.ts';
import type { ConversationStore } from './store.ts';

/**
 * 一问最多带几轮上文。取 5：足够覆盖"追问—再追问"的短链，又不会把整段会话塞进一次生成；
 * 上限同时写进 `note`，让"上下文被截断"这件事在装配面可见（不是静默截断）。
 */
export const CONTEXT_MAX_TURNS = 5;

/** 一轮上文（**只**含回答器需要的字段；不带 `owner_id`、不含正文原文，避免把内部键带出域）。 */
export interface ContextTurn {
  turn_id: string;
  revision: number;
  question: string;
  /** 该轮回答的状态；尚未结算（`queued`/`running`）或失败/超时 ⇒ `null`（不得假装有回答）。 */
  answer_status: AnswerStatus | null;
}

/** 一次上下文读取的结论（`turns` 按**时间正序**：最早的在前，最后一轮最靠近本轮）。 */
export interface ConversationContext {
  conversation_id: string;
  turns: readonly ContextTurn[];
}

/**
 * 上下文端口。`read()` 不接受"全部会话"这种参数：会话与主体都是**必填**的，
 * 这样"跨会话串上下文"在类型层面就写不出来。
 */
export interface ConversationContextPort {
  readonly kind: 'store' | 'unwired';
  readonly note: string;
  read(input: {
    conversationId: string;
    ownerId: string;
    /** 本轮轮次 id：必须被排除（它是"当前问"，不是"上文"）。 */
    excludeTurnId: string | null;
  }): Promise<ConversationContext>;
}

/** 未接线（缺省不用于本域；假装配在无 store 的场景）：恒空上下文，绝不退回任何本地数据。 */
export function createUnwiredConversationContext(
  note = '会话上下文端口未接线：追问一律按"没有上文"处理（不编造历史）',
): ConversationContextPort {
  return {
    kind: 'unwired',
    note,
    async read(input) {
      return { conversation_id: input.conversationId, turns: [] };
    },
  };
}

/**
 * store 版上下文端口：**唯一**的数据来源就是会话 store 的 `listTurns`（带 `ownerId`）。
 *
 * 读法：按 store 的既有排序（`created_at DESC, id DESC`）取最近 `maxTurns + 1` 条，去掉本轮后
 * 再按时间正序排 —— 这样存储侧顺序不是判据，本文件自己把顺序钉死（内存实现与 PG 实现同口径）。
 */
export function createStoreConversationContext(
  store: ConversationStore,
  options: { maxTurns?: number } = {},
): ConversationContextPort {
  const maxTurns = Math.max(1, Math.min(options.maxTurns ?? CONTEXT_MAX_TURNS, 50));
  return {
    kind: 'store',
    note: `会话上下文：同一会话、同一主体的最近 ${maxTurns} 轮提问（不含本轮；不跨会话）`,
    async read({ conversationId, ownerId, excludeTurnId }) {
      // `listTurns` 自带归属过滤（owner 不符与不存在同形返回空），因此这里**不需要**也不允许
      // 先读会话再判归属 —— 多一次读取只会多一个"以为读到了"的误判面。
      const rows = await store.listTurns(conversationId, ownerId, { limit: maxTurns + 1 });
      const prior = rows
        .filter((row) => (excludeTurnId === null ? true : row.turn.id !== excludeTurnId))
        .sort((left, right) => {
          const delta = left.turn.created_at.getTime() - right.turn.created_at.getTime();
          if (delta !== 0) return delta;
          return left.turn.id < right.turn.id ? -1 : left.turn.id > right.turn.id ? 1 : 0;
        })
        .slice(-maxTurns);
      return {
        conversation_id: conversationId,
        turns: prior.map((row) => ({
          turn_id: row.turn.id,
          revision: row.turn.revision,
          question: row.turn.input_text,
          answer_status: row.answer === null ? null : row.answer.status,
        })),
      };
    },
  };
}
