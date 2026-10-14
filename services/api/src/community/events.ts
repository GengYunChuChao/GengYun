/**
 * GY-I15（#15）阶段 2 · 社区事件 → 消息中心（**只调用已合并消息域的公开端口**）。
 *
 * ## 纪律（派单 §1／§2）
 *
 * - **不修改** `services/api/src/messages/**` 的任何实现；只调用其**内部创建口**
 *   `appendMessage(input)`（`messages/service.ts`，**不是**契约 operationId、不注册路由）。
 * - **不 import** 消息域（仓库既有分层：特征域不互相 import）。这里只声明
 *   **结构性端口** `MessageAppendPort`，由装配层把真实的 `MessagesService` 传进来。
 * - 事件类型只用契约 `Message.type` 闭集 `comment|like|moderation|system`：
 *   审核结果与下架都属于平台对内容的处置 ⇒ 一律 `moderation`。
 * - `event_key` = 「事件身份 + 版本」的去重键（`messages/types.ts` 的约定，
 *   例如 `comment:<comment_id>:r3`）。重复调度**不产生第二条消息**，且不重置读状态。
 * - `target_ref` 只用契约 `TargetRef` 闭集里的 `post` / `comment`，`revision` 取
 *   **事件发生时刻的版本**（不是内容最新版本）—— 消息记录的是"那一刻被处置的版本"。
 *
 * ## 诚实边界
 *
 * - 消息**不带正文**（契约 `Message` 没有 title/body 字段），因此这里只投递引用与类型；
 * - `reference_state` 由消息域**逐次现查**派生：社区侧的目标读取端口若未接线，
 *   消息的 `reference_state` 恒为 `unavailable`（消息域既有 fail-closed 口径）；
 *   本片**不**为消息域注入社区跳转读取端口（属跨线接线，见 PR 正文"未取得"）；
 * - 投递失败**不**回滚内容写入：内容与审核结论是权威结果，消息是通知。
 *   失败被如实回传（`delivered:false` + `reason`）并可被装配层记录，绝不谎报成功。
 */
import type { AuditState } from './types.ts';

/** 结构性端口：与 `messages/service.ts` 的 `appendMessage` 同形，但不 import 该域。 */
export interface MessageAppendPort {
  appendMessage(input: unknown): Promise<{ created: boolean; message: { id: string } }>;
}

/** 事件目标：契约 `TargetRef` 的社区子集。 */
export interface CommunityEventTarget {
  type: 'post' | 'comment';
  id: string;
  revision: number;
}

export type CommunityEvent =
  | {
      event: 'moderation_result';
      /** 接收者（内容作者）；由服务端给出，**绝不**来自客户端。 */
      ownerId: string;
      target: CommunityEventTarget;
      decision: AuditState;
      reasonCodes: readonly string[];
    }
  | {
      event: 'takedown';
      ownerId: string;
      target: CommunityEventTarget;
      /** 处置原因码（平台内部标签，**不**出现在契约 `Message` 上，只参与去重键）。 */
      reason: string;
    };

/** 投递结果（内部形状，**不是**契约 schema）。 */
export interface CommunityEventDelivery {
  delivered: boolean;
  /** 命中去重键时为既有消息 id（不新建）。 */
  messageId: string | null;
  created: boolean;
  reason: string | null;
}

export interface CommunityEventsPort {
  readonly wired: boolean;
  readonly note: string;
  publish(event: CommunityEvent): Promise<CommunityEventDelivery>;
}

function failed(reason: string): CommunityEventDelivery {
  return { delivered: false, messageId: null, created: false, reason };
}

/**
 * 事件去重键：`community:<event>:<type>:<id>:r<revision>[:<decision|reason>]`。
 *
 * 上限 200（`messages/validate.ts` 的 `EVENT_KEY_MAX`）：uuid 36 + 类型 7 + 固定前缀
 * 约 20 + decision/reason 最长 80 ⇒ 最坏约 150，安全。
 */
export function communityEventKey(event: CommunityEvent): string {
  const head = `community:${event.event}:${event.target.type}:${event.target.id}:r${event.target.revision}`;
  if (event.event === 'moderation_result') return `${head}:${event.decision}`;
  return `${head}:${event.reason.slice(0, 80)}`;
}

/** 未接线端口（默认）：如实回传"未投递"，绝不假装已通知、也不因此改写写路径结果。 */
export function createUnwiredCommunityEventsPort(
  reason = '消息中心端口未接线（real 模式消息持久存储未接线时即为本状态）',
): CommunityEventsPort {
  return {
    wired: false,
    note: `${reason}（fail-closed：不投递、不伪造消息记录）`,
    async publish() {
      return failed(reason);
    },
  };
}

/**
 * 已接线端口：把社区事件投递到消息域的公开创建口。
 *
 * - 只传 `owner_id`/`type`/`target_ref`/`event_key` 四个字段（消息域的
 *   `additionalProperties:false` 纪律：多传 `read_at`/`id`/`revision` 会被拒）；
 * - **不抛错**：消息域拒绝（例如入参非法）时回传 `delivered:false` + `reason`，
 *   让内容写路径的权威结果不被一条通知拖垮；
 * - 幂等由消息域的 `(owner_id, event_key)` 去重索引保证。
 */
export function createMessagesCommunityEventsPort(options: {
  messages: MessageAppendPort;
  note?: string;
}): CommunityEventsPort {
  return {
    wired: true,
    note: options.note ?? '事件投递到消息域公开创建口 appendMessage（同键去重，不新建第二条）',
    async publish(event) {
      try {
        const result = await options.messages.appendMessage({
          owner_id: event.ownerId,
          type: 'moderation',
          target_ref: {
            type: event.target.type,
            id: event.target.id,
            revision: event.target.revision,
          },
          event_key: communityEventKey(event),
        });
        return {
          delivered: true,
          messageId: typeof result?.message?.id === 'string' ? result.message.id : null,
          created: result?.created === true,
          reason: null,
        };
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        const reason = typeof code === 'string' && code !== '' ? code : 'EVENT_DELIVERY_FAILED';
        return failed(reason);
      }
    },
  };
}
