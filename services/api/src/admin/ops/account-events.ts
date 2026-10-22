/**
 * GY-I17（#17）阶段 2 · 账号级**系统事件** → 消息中心（只调用消息域的公开创建口）。
 *
 * ## 事件集（只两类，按裁定 `ruling-r31-i17-system-events-20261022.md`）
 *
 * - S1 `account_suspended`：平台对**账号**的处置（账号级，非内容级）；
 * - S2 `account_restored`：平台撤销处置、账号恢复可用。
 *
 * 契约 `Message` 没有 title/body/actor 文案载体，所以这里**不写**任何正文，只投递
 * 「事件类型 + 接收者 + 去重键」；`target_ref` 恒为 `null`（契约 `TargetRef` 闭集里没有
 * account 型，⛔ 不臆造一个）。
 *
 * ## 三条纪律
 *
 * - **不 import 消息域**：只声明**结构性端口** `AccountEventAppendPort`（与 `messages/service.ts`
 *   的 `appendMessage` 同形），由装配层把真实服务传进来（范本：`community/events.ts`）。
 * - **只在真变更时产出**（`outcome.changed === true`）：迁移 `0017` 的幂等分支
 *   （`IF x_before.state = 'suspended' THEN … 'changed', false`）不写审计、不递增 `auth_epoch`，
 *   重放同一停用**不得**再产生一条消息；`changed:false` 分支在这里**直接跳过**。
 * - **事务已提交之后**：`account-authority-pg.ts` 的 `call()` 在 `COMMIT` 之后才返回 outcome，
 *   装饰器因此只在"账号处置已落库"之后追加通知。通知失败**不回滚**账号处置（fail-open，口径
 *   同 `community/events.ts`「投递失败不回滚内容写入」），但**绝不说成成功**：
 *   `delivered:false` + `reason` + 计数 + `warn` 日志，全部可在装配层诊断。
 *
 * ## 事件键（确定性去重 + 版本）
 *
 * `system:account:suspend:<userId>:e<authEpoch>` / `system:account:restore:<userId>:e<authEpoch>`
 *
 * `authEpoch` 每次**真变更** `+1`、幂等分支不变 ⇒ 重试（同一笔处置的重放）命中同一键、
 * 第二次真停用得到新键。⛔ 不用 `auditId` 作键：`admin/ops/service.ts` 每次 `randomUUID()`，
 * 非确定性键会让同一事件写出多条消息。长度上界：`system:account:restore:`（23）+ uuid 36 +
 * `:e`（2）+ 安全整数 16 ⇒ ~77，远低于 `messages/validate.ts` 的 `EVENT_KEY_MAX`（200）。
 *
 * ## 可读性限制（如实，见 PR 正文「未取得」）
 *
 * 停用期间收件人 `state !== 'active'` ⇒ `/messages` 一律 401/403；恢复当前**没有** HTTP 路由
 * （`packages/contracts/operations.json` 只有 `suspendUser`）。因此本模块的证据只能到
 * **服务层 + PG 语句臂**：写入、去重、未读、`target_ref=null ⇒ unavailable` 语义，
 * ⛔ 不声称"收件人端到端可读"。
 */
import type { AccountAuthorityAction, AccountAuthorityOutcome, AdminAccountAuthority } from './account-authority-pg.ts';

/** 结构性端口：与 `messages/service.ts` 的 `appendMessage` 同形，但**不 import** 该域。 */
export interface AccountEventAppendPort {
  appendMessage(input: unknown): Promise<{ created: boolean; message: { id: string } }>;
}

/** 账号级系统事件（闭集只有两个成员；`ownerId` 是接收者，由服务端给出，⛔ 不来自客户端）。 */
export type AccountSystemEvent =
  | {
      event: 'account_suspended';
      /** 被处置账号（`outcome.account.id`，即 `suspend_account()` 的 `UPDATE … RETURNING id`）。 */
      ownerId: string;
      /** 处置后的 `auth_epoch`（每次真变更 +1）；同时是去重键的版本段。 */
      authEpoch: number;
    }
  | {
      event: 'account_restored';
      ownerId: string;
      authEpoch: number;
    };

/**
 * 事件去重键：`system:account:<suspend|restore>:<userId>:e<authEpoch>`。
 *
 * 「事件身份（谁 + 哪一类处置）+ 版本（哪一次真变更）」全参与 ⇒ 重试同键、二次处置新键。
 */
export function accountSystemEventKey(event: AccountSystemEvent): string {
  const action = event.event === 'account_suspended' ? 'suspend' : 'restore';
  return `system:account:${action}:${event.ownerId}:e${event.authEpoch}`;
}

/** 投递结果（内部形状，**不是**契约 schema）。 */
export interface AccountEventDelivery {
  /** 消息域是否接受并落库（同键去重也算 `true`，`created` 另行区分）。 */
  delivered: boolean;
  /** 命中去重键时为既有消息 id（不新建）。 */
  messageId: string | null;
  created: boolean;
  /** 失败原因码（不写驱动/消息域内部细节）；成功为 `null`。 */
  reason: string | null;
}

/** 可诊断计数：装配层/测试都可读（失败不回滚，但必须留痕）。 */
export interface AccountEventCounters {
  /** 消息域接受（含同键去重）的次数。 */
  delivered: number;
  /** 消息域拒绝/抛错的次数（fail-open：账号处置结果不受影响）。 */
  failed: number;
  /** `changed === false` 的幂等分支被**跳过**的次数（= 不产生消息）。 */
  skipped: number;
}

export interface AccountEventsPort {
  readonly wired: boolean;
  readonly note: string;
  /** 活对象（每次投递就地累加），只用于诊断与断言，不参与任何业务判定。 */
  readonly counters: AccountEventCounters;
  publish(event: AccountSystemEvent): Promise<AccountEventDelivery>;
}

function failed(reason: string): AccountEventDelivery {
  return { delivered: false, messageId: null, created: false, reason };
}

/** 未接线端口（默认）：如实回传"未投递"，绝不假装已通知、也不因此改写账号处置结果。 */
export function createUnwiredAccountEventsPort(
  reason = '消息服务未接线：账号停用/恢复的系统事件无法投递',
): AccountEventsPort {
  const counters: AccountEventCounters = { delivered: 0, failed: 0, skipped: 0 };
  return {
    wired: false,
    note: `${reason}（fail-open：账号处置照常返回，事件不投递且留计数）`,
    counters,
    async publish() {
      counters.failed += 1;
      return failed(reason);
    },
  };
}

/**
 * 已接线端口：把账号事件投递到消息域的公开创建口。
 *
 * - 只传 `owner_id`/`type`/`target_ref`/`event_key` 四个字段（消息域 `additionalProperties:false`：
 *   多传 `read_at`/`id`/`revision` 会被拒）；`target_ref` 恒 `null` ⇒ 详情/列表的
 *   `reference_state` 恒 `unavailable` 且**不调用**目标读取端口（`messages/service.ts` 早返回）；
 * - **不抛错**：消息域拒绝（入参非法等）或驱动抛错时回传 `delivered:false` + `reason` 并累加
 *   `failed`，让账号处置的权威结果不被一条通知拖垮；
 * - 幂等由消息域的 `(owner_id, event_key)` 去重索引保证：同键第二次 `created:false`、
 *   **不重置**读状态。
 */
export function createMessagesAccountEventsPort(options: {
  messages: AccountEventAppendPort;
  note?: string;
}): AccountEventsPort {
  const counters: AccountEventCounters = { delivered: 0, failed: 0, skipped: 0 };
  return {
    wired: true,
    note: options.note ?? '账号事件投递到消息域公开创建口 appendMessage（同键去重，不新建第二条）',
    counters,
    async publish(event) {
      try {
        const result = await options.messages.appendMessage({
          owner_id: event.ownerId,
          type: 'system',
          target_ref: null,
          event_key: accountSystemEventKey(event),
        });
        counters.delivered += 1;
        return {
          delivered: true,
          messageId: typeof result?.message?.id === 'string' ? result.message.id : null,
          created: result?.created === true,
          reason: null,
        };
      } catch (error) {
        counters.failed += 1;
        const code = (error as { code?: unknown })?.code;
        return failed(typeof code === 'string' && code !== '' ? code : 'EVENT_DELIVERY_FAILED');
      }
    },
  };
}

/** 装配层可注入的日志口（Fastify/pino 子集；只用到 `warn`）。 */
export interface AccountEventLogPort {
  warn(payload: Record<string, unknown>, message?: string): void;
}

/**
 * 账号写权威装饰器：**原样透传** `suspend`/`restore` 的入参与返回值，只在
 * `outcome.changed === true` 时追加一条系统事件。
 *
 * - 时序：`authority.suspend()` 返回即代表 PG 事务已 `COMMIT`（见 `account-authority-pg.ts`
 *   的 `call()`），通知在其**之后**发出；
 * - fail-open：通知抛错/被拒**不影响**已提交的账号处置，也不改变返回的 outcome 对象
 *   （同一引用，不做字段改写）；
 * - 幂等分支：`changed === false` ⇒ 不投递（计数 `skipped` +1），重放不产生第二条消息；
 * - 计数与日志：`events.counters` 就地累加；失败时用注入的 `log.warn` 留一条可诊断记录
 *   （含事件类型、接收者、`authEpoch`、原因码与累计失败数）。
 */
export function withAccountSystemEvents(
  authority: AdminAccountAuthority,
  options: { events: AccountEventsPort; log?: AccountEventLogPort },
): AdminAccountAuthority {
  const counters = options.events.counters;

  function reportFailure(event: AccountSystemEvent, delivery: AccountEventDelivery): void {
    options.log?.warn(
      {
        event: event.event,
        owner_id: event.ownerId,
        auth_epoch: event.authEpoch,
        reason: delivery.reason,
        delivered: delivery.delivered,
        failed_total: counters.failed,
        wired: options.events.wired,
      },
      'GY-I17 账号系统事件投递失败（已提交的账号处置不回滚，fail-open）',
    );
  }

  async function notify(kind: 'suspend' | 'restore', outcome: AccountAuthorityOutcome): Promise<void> {
    if (outcome.changed !== true) {
      // 幂等分支（重复停用/已恢复再恢复）：没有真变更 ⇒ 0 条新消息、不重置读状态。
      counters.skipped += 1;
      return;
    }
    const event: AccountSystemEvent =
      kind === 'suspend'
        ? { event: 'account_suspended', ownerId: outcome.account.id, authEpoch: outcome.authEpoch }
        : { event: 'account_restored', ownerId: outcome.account.id, authEpoch: outcome.authEpoch };
    let delivery: AccountEventDelivery;
    try {
      delivery = await options.events.publish(event);
    } catch (error) {
      // 端口本身违约（例如注入的自定义端口抛错）：折叠成"未投递"，仍不回滚。
      const code = (error as { code?: unknown })?.code;
      delivery = failed(typeof code === 'string' && code !== '' ? code : 'EVENT_DELIVERY_FAILED');
    }
    if (!delivery.delivered) reportFailure(event, delivery);
  }

  return {
    persistent: true,
    async suspend(action: AccountAuthorityAction): Promise<AccountAuthorityOutcome> {
      const outcome = await authority.suspend(action);
      await notify('suspend', outcome);
      return outcome;
    },
    async restore(action: AccountAuthorityAction): Promise<AccountAuthorityOutcome> {
      const outcome = await authority.restore(action);
      await notify('restore', outcome);
      return outcome;
    },
  };
}
