/**
 * GY-R73（#17）· **来源/条目被撤回 ⇒ 通知收藏过它的用户**：`system` 消息的第二个生产点。
 *
 * 为什么要有这一片（侦察结论）：`system` 消息此前**只有一个**生产点——账号停用/恢复
 * （`admin/ops/account-events.ts`），而那个生产点的收件人令牌随即永久失效
 * （`miniprogram/utils/auth.js:58` 的 `ACCOUNT_INACTIVE`）⇒ 生产上没有活着的用户读得到
 * `system` 通知。本片把 `system` 接到一条**收件人仍然在线**的真实事件上：
 * 一个来源/一条资料被后台撤回，先前收藏过受影响资料的普通用户各收到一条通知。
 *
 * 三条纪律（与 `account-events.ts` 逐条同口径，⛔ 不得放宽）：
 *   1. **只看已提交的权威结果**：`outcome.body.data.changed === true` 才产出。撤回是
 *      `lifecycle` 的终态迁移（`draft|published|withdrawn` 三者之间**没有** restore），
 *      重复撤回在 `admin/service.ts:491` 幂等短路成 `changed:false` ⇒ **重放不产生第二条**；
 *   2. **fail-open**：通知在事务 `COMMIT` 之后发出，投递失败**不回滚**已提交的撤回、不改
 *      返回的 outcome 对象（同一引用、不改写字段），只回 `delivered:false` + 计数 + `warn`；
 *   3. **不 import 消息域/收藏域的实现**：只声明结构性端口（`appendMessage` / `listOwnerIdsByTarget`
 *      的最小形状），本文件因此能在内存臂与 PG 臂上同样被装配。
 *
 * 收件人怎么算（三层，逐层可空但要如实计数）：
 *   受影响资料 = `reference-integrity.referencesOf(来源)` 里判为 `unavailable` 且属 `knowledge`
 *   家族、且型别落 `species|herbicide|scheme` 的那些（其余两族 `registrations`/`restrictions`
 *   的 target 型别与公开收藏面的 id 空间不共享，⛔ 不拿它们的 id 去猜收藏者）；
 *   收藏者 = `favorites.listOwnerIdsByTarget(型别, id)`（迁移 0054 的 `(target_type, target_id, owner_id)`）；
 *   真正收件人 = 收藏者 ∩ `public.users.state = 'active'`（⛔ 不再往永久读不到通知的账号堆消息）。
 *
 * 已知边界（如实登记，⛔ 不要在本文件里"修好"）：**收件人集合在生产数据上恒空（机制就绪、数据面未接）**。
 *   ㊀ 收藏的 `target_id` 是**公开目录**的 id：可用性逐次按 `services/api/src/app.ts:1914` 的
 *     `SELECT id, revision, type FROM catalog_read.current_knowledge WHERE id = $1::uuid` 核验，而目录行
 *     只由 `db/seeds/seed_zhejiang_materials.sql` 种入（全仓唯一的 `INSERT INTO knowledge_versions`）。
 *   ㊁ 被撤回的**后台实体** id 由服务端生成、只落 `admin_content_entities`：写入点是
 *     `services/api/src/admin/ops/content-pg.ts:279`，id 取 `services/api/src/admin/store.ts:142` 的
 *     `randomUUID()`，且 `services/api/src/admin/service.ts:287` 调 `createEntity` 时**不传 id**
 *     ⇒ 管理 API 铸不出与目录同号的实体。
 *   ㊂ `services/api/src/**` 里没有任何 `INSERT INTO knowledge_versions/sources/source_versions`
 *     （grep 为空）⇒ 两侧 id 空间不同源、也没有写入桥。于是本片能做到「撤回 ⇒ 按 `(型别, id)` 找收藏者
 *     ⇒ 各写一条消息」，但真实的"收藏过它的人"要等后台实体真正进入公开目录之后才非空。
 *   ⇒ 消息读面的 `reference_state` 另由 `messages/service.ts` 按公开读面逐次重算：被撤回的条目在公开面
 *     查不到 ⇒ `unavailable` ⇒ 小程序落到既有的「关联内容当前不可查看，本条不提供跳转入口。」空态（⛔ 不是 404）。
 *   - 消息体只有 `type='system'` + `target_ref`：消息域的公开创建口
 *     （`messages/validate.ts` 的 `validateAppendMessageInput`）**只收**四个字段，没有正文/标题位。
 */

import { FAVORITE_TARGET_TYPES } from '../../favorites/types.ts';
import { headRevision } from '../families.ts';
import { createAsyncReferenceIntegrity } from '../reference-integrity.ts';
import type { DraftEnvelope } from '../service.ts';
import type { AdminContentStoreLike } from '../store.ts';
import type { AdminCallContext, ServiceResponse } from '../types.ts';

/** 可收藏型别闭集（`favorites/types.ts` 的 `FAVORITE_TARGET_TYPES`，⛔ 不在此扩表）。 */
function isFavoritableTargetType(value: string): boolean {
  return (FAVORITE_TARGET_TYPES as readonly string[]).includes(value);
}

/** 消息域公开创建口的最小形状（结构性子集，⛔ 不 import `messages/service.ts`）。 */
export interface InvalidationAppendPort {
  appendMessage(input: unknown): Promise<{ created: boolean; message: { id: string } }>;
}

/** 收藏域反查口的最小形状（PG 臂与内存臂逐字同形：`FavoritesStore.listOwnerIdsByTarget`）。 */
export interface FavoritedOwnersPort {
  listOwnerIdsByTarget(targetType: string, targetId: string): Promise<readonly string[]>;
}

/** 只留状态正常的主体；`public.users.state` 是 `user_state` 枚举（`active|suspended|deletion_pending|deleted`）。 */
export interface ActiveOwnersPort {
  readonly wired: boolean;
  readonly note: string;
  filterActive(ownerIds: readonly string[]): Promise<readonly string[]>;
}

/** 装配层可注入的日志口（Fastify/pino 子集；只用到 `warn`）。 */
export interface InvalidationLogPort {
  warn(payload: Record<string, unknown>, message?: string): void;
}

/** 一个"受影响目标"（契约 `TargetRef` 的三字段形状；型别已收窄到可收藏的 3 类）。 */
export interface InvalidationTarget {
  readonly type: string;
  readonly id: string;
  readonly revision: number;
}

/** 撤回影响面：来源撤回 ⇒ 多条；条目自身撤回 ⇒ 它自己那条。 */
export interface InvalidationImpactPort {
  affectedBySource(sourceId: string): Promise<readonly InvalidationTarget[]>;
  affectedEntry(entryId: string): Promise<InvalidationTarget | null>;
  /**
   * 本次撤回的**稳定时刻令牌**（epoch ms，取 `entity.withdrawnAt`）。
   *
   * 为什么要它：`lifecycle` 不是单向的——`withdrawn` 可以经**重新发布**回到 `published`
   * （`tests/unit/admin-content-lifecycle.test.mjs:192-194` 钉的就是这条迁移），于是同一个来源
   * 可以被撤回**两次**，那是两个不同的真实事件、应当各发一条通知。只用
   * `(撤回对象, 受影响目标)` 做键会把第二次静默吞掉（`created:false`）。
   * 反过来，同一次撤回的重放（幂等键重放走缓存 outcome）读到的是同一个 `withdrawnAt`
   * ⇒ 键不变 ⇒ 不产生第二条。取不到时回 `0`（宁可退化成"只发一次"，也不重复轰炸）。
   */
  withdrawalToken(causeId: string): Promise<number>;
}

/** 一条待投递的系统通知（`event_key` 由 `invalidationEventKey()` 生成，⛔ 调用方不许另造）。 */
export interface InvalidationEvent {
  readonly ownerId: string;
  readonly targetRef: InvalidationTarget;
  readonly eventKey: string;
}

export interface InvalidationDelivery {
  readonly delivered: boolean;
  readonly messageId: string | null;
  readonly created: boolean;
  readonly reason: string | null;
}

export interface InvalidationNoticeCounters {
  delivered: number;
  failed: number;
  skipped: number;
}

/** 投递口（fail-open 的边界就在这一层：`publish` 永不抛错）。 */
export interface InvalidationEventsPort {
  readonly wired: boolean;
  readonly note: string;
  readonly counters: InvalidationNoticeCounters;
  publish(event: InvalidationEvent): Promise<InvalidationDelivery>;
}

/** 路由层用到的两个撤回动作（`admin/service.ts` 的四族里只有这两族有可收藏目标）。 */
export interface WithdrawalAuthority {
  withdrawSource(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;
  withdrawKnowledge(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;
}

/** 装配层可注入的最小查询口（`node-postgres` 的 `query(text, values)` 子集）。 */
export interface InvalidationQueryPort {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly unknown[] }>;
}

/**
 * 幂等键：`system:invalidate:<src|ent>:<撤回对象 id>:t<撤回时刻>:<受影响型别>:<受影响 id>`。
 *
 * - **带撤回时刻**（`entity.withdrawnAt` 的 epoch ms）：`withdrawn` 能经重新发布回到 `published`，
 *   因此同一来源可以被撤回两次、那是两个真实事件 ⇒ 两次各一条消息；而**同一次**撤回的重放
 *   （幂等键重放拿到缓存的 outcome）读到的 `withdrawnAt` 不变 ⇒ 键不变 ⇒ 只有一条。
 *   ⛔ 不要换成 `Date.now()`：那样每次重放都会造一条新消息，幂等就没了；
 * - 长度上界：`system:invalidate:` 18 + `src|ent` 3 + id 36 + `t`+13 + 型别 10 + id 36 + 五个分隔符
 *   ≈ 121，低于消息域 `validate.ts` 的 `EVENT_KEY_MAX = 200`；
 * - 全小写：撤回路由的 `:id` 与契约 uuid 都是小写 hex，本函数对 id 再兜一次 `toLowerCase()`，
 *   避免大小写不同的同一对象写出两条消息。
 */
export function invalidationEventKey(input: {
  kind: 'source' | 'entry';
  causeId: string;
  token: number;
  target: InvalidationTarget;
}): string {
  const kindTag = input.kind === 'source' ? 'src' : 'ent';
  return [
    'system',
    'invalidate',
    kindTag,
    input.causeId.trim().toLowerCase(),
    `t${input.token}`,
    input.target.type,
    input.target.id.trim().toLowerCase(),
  ].join(':');
}

/** 一个永远"投不出去"的投递口（消息服务未接线时如实 `wired:false`，⛔ 不伪造投递）。 */
export function createUnwiredInvalidationEventsPort(reason: string): InvalidationEventsPort {
  const counters: InvalidationNoticeCounters = { delivered: 0, failed: 0, skipped: 0 };
  return {
    wired: false,
    note: reason,
    counters,
    async publish() {
      counters.failed += 1;
      return { delivered: false, messageId: null, created: false, reason: 'EVENT_PORT_UNWIRED' };
    },
  };
}

/**
 * 已接线投递口：把通知交给消息域的公开创建口。
 *
 * 只传 `owner_id`/`type`/`target_ref`/`event_key` 四个字段（消息域 `additionalProperties:false`，
 * 多传 `read_at`/`id`/`revision` 会被拒）；`target_ref` 给**受影响资料**，读面按它逐次重算
 * `reference_state`。幂等由消息域的 `(owner_id, event_key)` 去重索引保证：同键第二次
 * `created:false`、**不重置**读状态。
 */
export function createMessagesInvalidationEventsPort(options: {
  messages: InvalidationAppendPort;
  note?: string;
}): InvalidationEventsPort {
  const counters: InvalidationNoticeCounters = { delivered: 0, failed: 0, skipped: 0 };
  return {
    wired: true,
    note: options.note ?? '撤回通知投递到消息域公开创建口 appendMessage（同键去重，不新建第二条）',
    counters,
    async publish(event) {
      try {
        const result = await options.messages.appendMessage({
          owner_id: event.ownerId,
          type: 'system',
          target_ref: {
            type: event.targetRef.type,
            id: event.targetRef.id,
            revision: event.targetRef.revision,
          },
          event_key: event.eventKey,
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
        return {
          delivered: false,
          messageId: null,
          created: false,
          reason: typeof code === 'string' && code !== '' ? code : 'EVENT_DELIVERY_FAILED',
        };
      }
    },
  };
}

/** 未接线的主体状态过滤口：**一个都不放行**（宁可少发，也不往可能已停用的账号堆消息）。 */
export function createUnwiredActiveOwnersPort(reason: string): ActiveOwnersPort {
  return {
    wired: false,
    note: reason,
    async filterActive() {
      return [];
    },
  };
}

/**
 * 已接线主体状态过滤口：`public.users.state = 'active'`。
 *
 * 授权面：运行角色对 `public.users` 的 `id`/`state` 早有列级 `SELECT`
 * （`services/api/src/privacy/ledger-pg.ts:1035`、`knowledge/service.ts:64` 都按运行角色读它）
 * ⇒ 本片**不需要**动 `deploy/**` 的任何授权语句（⛔ 授权面变更必须经用户）。
 */
export function createPostgresActiveOwnersPort(options: {
  pool: InvalidationQueryPort;
  note?: string;
}): ActiveOwnersPort {
  return {
    wired: true,
    note: options.note ?? "public.users 里 state='active' 的主体（停用/注销中的账号不再收通知）",
    async filterActive(ownerIds) {
      const ids = [...new Set(ownerIds.filter((id) => typeof id === 'string' && id !== ''))];
      if (ids.length === 0) return [];
      const { rows } = await options.pool.query(
        "SELECT id FROM public.users WHERE id = ANY($1::uuid[]) AND state = 'active' ORDER BY id",
        [ids],
      );
      return rows.map((row) => String((row as { id?: unknown }).id ?? '')).filter((id) => id !== '');
    },
  };
}

/**
 * 影响面端口：判据全部复用 `reference-integrity.ts` 的既有裁决（⛔ 不在这里另写一套判定）。
 *
 * - 来源撤回：`referencesOf(sourceId)` 里 `family === 'knowledge'` 且 `state === 'unavailable'`
 *   的依赖行（`source_withdrawn` / `source_not_published` / `source_version_mismatch` 三类都落在
 *   `unavailable`，与 `public-invalidation.ts:13-24` 的 `VISIBLE_BY_STATE` 逐条同向）；
 * - 条目自身撤回：该实体自己（`withdrawKnowledge` 之后 `lifecycle='withdrawn'`）。
 *
 * 型别一律取 `headRevision(entity).content.type`（knowledge 家族的 `targetRefTypeFor` 就是它），
 * 且只放行可收藏的 3 类——`static_region` 等不可收藏型别即便被撤回也**没有收藏者**，不进通知。
 */
export function createStoreImpactPort(store: AdminContentStoreLike): InvalidationImpactPort {
  const integrity = createAsyncReferenceIntegrity(store);

  async function targetOf(entityId: string): Promise<InvalidationTarget | null> {
    const entity = await store.getEntity(entityId);
    if (entity === undefined) return null;
    const head = headRevision(entity);
    const type = String((head.content as { type?: unknown } | null)?.type ?? '');
    if (!isFavoritableTargetType(type)) return null;
    return { type, id: entity.id, revision: head.revision };
  }

  return {
    async affectedBySource(sourceId) {
      const references = await integrity.referencesOf(sourceId);
      const affected: InvalidationTarget[] = [];
      for (const reference of references) {
        if (reference.family !== 'knowledge') continue;
        if (reference.state !== 'unavailable') continue;
        const target = await targetOf(reference.id);
        if (target !== null) affected.push(target);
      }
      return affected;
    },
    affectedEntry: targetOf,
    async withdrawalToken(causeId) {
      const entity = await store.getEntity(causeId);
      const withdrawnAt = entity?.withdrawnAt;
      return withdrawnAt instanceof Date ? withdrawnAt.getTime() : 0;
    },
  };
}

export interface WithdrawalInvalidationOptions {
  store: AdminContentStoreLike;
  favorites: FavoritedOwnersPort;
  /** 消息服务（`null` ⇒ 未接线，如实 `wired:false`）。 */
  messages: InvalidationAppendPort | null;
  /** 运行角色可用的库池（`null` ⇒ 无主体状态过滤能力，如实 `wired:false`）。 */
  pool?: InvalidationQueryPort | null;
  /** 测试注入点（缺省按 `store` 构造）。 */
  impact?: InvalidationImpactPort;
  /** 测试注入点（缺省按 `pool` 构造）。 */
  activeOwners?: ActiveOwnersPort;
  log?: InvalidationLogPort;
}

export interface WithdrawalInvalidationNotices {
  readonly counters: InvalidationNoticeCounters;
  readonly events: InvalidationEventsPort;
  readonly activeOwners: ActiveOwnersPort;
  /** 来源撤回后追加通知；**永不抛错**（fail-open）。 */
  notifySourceWithdrawn(sourceId: unknown, outcome: ServiceResponse<DraftEnvelope>): Promise<void>;
  /** 条目撤回后追加通知；**永不抛错**（fail-open）。 */
  notifyEntryWithdrawn(entryId: unknown, outcome: ServiceResponse<DraftEnvelope>): Promise<void>;
}

/** 只认"真的变了"的那一次：`changed:false` 是幂等短路（重放），不投递、不重置读状态。 */
function isCommittedChange(outcome: ServiceResponse<DraftEnvelope> | undefined): boolean {
  const data = outcome?.body?.data;
  return (
    typeof data === 'object' && data !== null && (data as { changed?: unknown }).changed === true
  );
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * 组一个"撤回 ⇒ 收藏者通知"的装配体（端口 + 计数 + 两个永不抛错的 `notify*`）。
 *
 * fail-open 的两道闸：`notify*` 内部整体 `try/catch`（影响面查询/受众查询抛错也只记 `warn`）；
 * `events.publish` 自己把消息域异常折叠成 `delivered:false`（端口违约再被外层兜一次）。
 */
export function createWithdrawalInvalidationNotices(
  options: WithdrawalInvalidationOptions,
): WithdrawalInvalidationNotices {
  const impact = options.impact ?? createStoreImpactPort(options.store);
  const activeOwners =
    options.activeOwners ??
    (options.pool === undefined || options.pool === null
      ? createUnwiredActiveOwnersPort('库池未接线：无法过滤停用/注销账号，本片一条都不投递')
      : createPostgresActiveOwnersPort({ pool: options.pool }));
  const events =
    options.messages === null
      ? createUnwiredInvalidationEventsPort('消息服务未接线：撤回通知无法投递')
      : createMessagesInvalidationEventsPort({ messages: options.messages });
  const counters = events.counters;

  function reportFailure(payload: Record<string, unknown>, reason: string): void {
    options.log?.warn(
      { ...payload, reason, failed_total: counters.failed, wired: events.wired },
      'GY-R73 撤回系统通知投递失败（已提交的撤回不回滚，fail-open）',
    );
  }

  async function notifyTargets(
    kind: 'source' | 'entry',
    causeId: string,
    token: number,
    targets: readonly InvalidationTarget[],
  ): Promise<void> {
    if (!activeOwners.wired) {
      counters.skipped += 1;
      reportFailure({ kind, cause_id: causeId, targets: targets.length }, activeOwners.note);
      return;
    }
    for (const target of targets) {
      if (!isFavoritableTargetType(target.type)) {
        counters.skipped += 1;
        continue;
      }
      const owners = await options.favorites.listOwnerIdsByTarget(target.type, target.id);
      if (owners.length === 0) {
        counters.skipped += 1;
        continue;
      }
      const recipients = await activeOwners.filterActive(owners);
      if (recipients.length === 0) {
        counters.skipped += 1;
        continue;
      }
      const eventKey = invalidationEventKey({ kind, causeId, token, target });
      for (const ownerId of recipients) {
        let delivery: InvalidationDelivery;
        try {
          delivery = await events.publish({
            ownerId,
            targetRef: target,
            eventKey,
          });
        } catch (error) {
          const code = (error as { code?: unknown })?.code;
          delivery = {
            delivered: false,
            messageId: null,
            created: false,
            reason: typeof code === 'string' && code !== '' ? code : 'EVENT_DELIVERY_FAILED',
          };
          counters.failed += 1;
        }
        if (!delivery.delivered) {
          reportFailure(
            {
              kind,
              cause_id: causeId,
              target_type: target.type,
              target_id: target.id,
              owner_id: ownerId,
              event_key: eventKey,
            },
            delivery.reason ?? 'EVENT_DELIVERY_FAILED',
          );
        }
      }
    }
  }

  async function run(
    kind: 'source' | 'entry',
    rawId: unknown,
    outcome: ServiceResponse<DraftEnvelope>,
    resolveTargets: (causeId: string) => Promise<readonly InvalidationTarget[]>,
    label: string,
  ): Promise<void> {
    try {
      if (!isCommittedChange(outcome)) {
        // 幂等分支（重复撤回 / 未发布被拒）：没有真变更 ⇒ 0 条新消息、不重置读状态。
        counters.skipped += 1;
        return;
      }
      const causeId = normalizeId(rawId);
      if (causeId === '') {
        counters.skipped += 1;
        return;
      }
      const targets = await resolveTargets(causeId);
      if (targets.length === 0) {
        counters.skipped += 1;
        return;
      }
      const token = await impact.withdrawalToken(causeId);
      await notifyTargets(kind, causeId, token, targets);
    } catch (error) {
      // 影响面/受众的任何抛错都在这里被吞掉：撤回已经 COMMIT，通知不许把结果翻成失败。
      counters.failed += 1;
      const code = (error as { code?: unknown })?.code;
      reportFailure(
        { kind, cause_id: normalizeId(rawId), stage: label },
        typeof code === 'string' && code !== '' ? code : 'EVENT_DELIVERY_FAILED',
      );
    }
  }

  return {
    counters,
    events,
    activeOwners,
    async notifySourceWithdrawn(sourceId, outcome) {
      await run('source', sourceId, outcome, (causeId) => impact.affectedBySource(causeId), 'impact');
    },
    async notifyEntryWithdrawn(entryId, outcome) {
      await run(
        'entry',
        entryId,
        outcome,
        async (causeId) => {
          const target = await impact.affectedEntry(causeId);
          return target === null ? [] : [target];
        },
        'impact',
      );
    },
  };
}

/**
 * 撤回装饰器：**原样透传** `withdrawSource`/`withdrawKnowledge` 的入参与返回值，只在
 * `outcome.body.data.changed === true` 时按影响面给收藏者各追加一条 `system` 消息。
 *
 * - 时序：`authority.withdraw*()` 返回即代表 PG 事务已 `COMMIT`（`admin/service.ts` 的
 *   `runIdempotentWrite` 在 `store.commitLifecycle` 之后才构造 outcome），通知在其**之后**发出；
 * - fail-open：通知抛错/被拒**不影响**已提交的撤回，也不改变返回的 outcome 对象（同一引用）；
 * - 异常映射不变：`withdraw*` 自己拒绝（`OBJECT_UNAVAILABLE`/`SOURCE_CONFLICT`/403…）时
 *   异常**原样上抛**，本装饰器不捕获、不改写错误码；
 * - 只挂这两族：`registrations`/`restrictions` 的契约 target 型别与公开收藏面的 id 空间
 *   不共享（`families.ts:199/:226` 的注释），给它们发通知只会误伤。
 */
export function withWithdrawalInvalidationNotices<T extends WithdrawalAuthority>(
  authority: T,
  options: WithdrawalInvalidationOptions,
): T {
  return withInvalidationNotices(authority, createWithdrawalInvalidationNotices(options));
}

/**
 * 同上的**装配后**版本：接受已建好的 `notices`（便于测试直接读 `counters`，
 * 也便于将来把同一个 `notices` 复用到别的装配点）。语义与上面逐字相同。
 */
export function withInvalidationNotices<T extends WithdrawalAuthority>(
  authority: T,
  notices: WithdrawalInvalidationNotices,
): T {
  return {
    ...authority,
    async withdrawSource(ctx: AdminCallContext, id: string, body: unknown) {
      const outcome = await authority.withdrawSource(ctx, id, body);
      await notices.notifySourceWithdrawn(id, outcome);
      return outcome;
    },
    async withdrawKnowledge(ctx: AdminCallContext, id: string, body: unknown) {
      const outcome = await authority.withdrawKnowledge(ctx, id, body);
      await notices.notifyEntryWithdrawn(id, outcome);
      return outcome;
    },
  };
}
