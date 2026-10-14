/**
 * GY-I17（#17）消息域服务层；HTTP 装配在 routes/messages.ts，领域层不注册路由。
 *
 * 覆盖契约 operationId：`listMessages`（`GET /messages`）、
 * `getUnreadCount`（`GET /messages/unread-count`）、`markMessageRead`（`PUT /messages/{id}/read`）。
 * 另有**内部创建口** `appendMessage`（**不是**契约 operationId，**不注册**任何路由）。
 *
 * ## 核心不变式
 *
 * 1. **归属**：读取/标记只看得到本人的消息。他人消息与"不存在"**同形**：同一个
 *    `notFound()` ⇒ 同 code / 同 status / 同 message / 同空 details ⇒ 同一份
 *    `buildErrorEnvelope` 逐字节相同（不泄露存在性）。
 * 2. **未读一致性**：`unread-count` 是**派生量**（每次现算 `read_at === null` 的本人行数），
 *    不是计数器 ⇒ 不存在漂移路径；`markMessageRead` **幂等**（重复标记不改首次
 *    `read_at`、不再减未读、不再推进版本）且**单调**（绝不增加未读）；并发标记同一消息由存储层的
 *    同步 CAS 临界区保证**只发生一次** `null → 时刻`（= **恰好一次版本推进**）。
 * 3. **强 ETag ↔ 资源版本**（冻结条款，见证据文档 §12 逐字引文）：`read_at` 是契约 `Message`
 *    的字段，首次未读→已读**改变了资源表示** ⇒ **必须推进 `revision`**（自 1 递增），
 *    使 `ETag: "<revision>"` 随资源状态变化；**不同资源状态不得共用同一个强 ETag**。
 *    `If-Match` 是目标**当前**强 ETag：不匹配 ⇒ 409（首次标记后旧 ETag 即不再匹配）。
 *    本片提供 `strongEtagOf(revision)`，阶段 2 路由层据此写 `ETag` 头。
 * 4. **引用可用性 fail-closed**：`reference_state` 每次读取按**目标当前状态**派生；
 *    未接线/端口抛错/返回非闭集取值/无 `target_ref` 一律 `unavailable`，
 *    绝不假装可用，也绝不借消息泄露目标内容或存在性（消息本身不存目标正文）。
 * 5. **出口不可变**：所有返回给调用方的对象都是从存储**深拷贝**出来的自有数据。
 *
 * ## 未取得（如实声明，不得当作已完成）
 *
 * - 返回契约 data 载荷；routes/messages.ts 补齐 HTTP 鉴权、头部与封套；
 *   real 模式在消息持久存储未接线时关闭，不能把内存 HTTP 记作生产能力；
 * - 没有数据库迁移，只有内存存储（进程重启即丢）；
 * - **目标读取端口未接线**（`createUnwiredReferencePort`）⇒ 现阶段所有带目标的消息
 *   `reference_state` 恒为 `unavailable`；本片**不宣称**消息系统已端到端可用；
 * - 首版**不接**微信外部推送，**不虚构**真人互动消息（消息只能由服务端内部口产生）；
 * - 「注销去身份同步」「审核/社区事件写入消息」属其它任务（GY-I19 / GY-I14/15/18）。
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { idempotencyKeyHashHex, idempotencyRequestHash, idempotencyScope } from '../auth/idempotency.ts';
import { ApiError } from '../errors.ts';
import { cloneDeep } from './immutable.ts';
import type { MessageReferencePort } from './reference.ts';
import type { IdempotencyOutcome, MessageRecord, MessagesStore, MarkReadResult } from './store.ts';
import { compareMessagesDescending } from './store.ts';
import type { Message, MessagePage, ReferenceState, UnreadCount } from './types.ts';
import {
  parseListMessagesQuery,
  requireIdempotencyKey,
  requireIfMatch,
  requireUserActor,
  requireUuidParam,
  validateAppendMessageInput,
} from './validate.ts';

/** 游标有效期（与知识/社区/后台读口径一致：只服务翻页，不做长期令牌）。 */
export const CURSOR_TTL_MS = 15 * 60 * 1000;
/** 幂等重放窗口（契约参数描述：只覆盖客户端超时重试）。 */
export const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
/** 同键并发等待上界：超过即 409 REQUEST_IN_PROGRESS。 */
export const IDEMPOTENCY_WAIT_MS = 2000;

/**
 * 契约强 ETag 的唯一构造口径：`ETag: "<revision>"`。
 *
 * 依据（逐字引文见证据文档 §12）：`docs/architecture/state-contract.md`
 * 「GET 条目带强 ETag `"<revision>"`；版本整数自1递增，PATCH/DELETE/取消以及
 * OpenAPI 标注的创建要求 `If-Match`，缺失428，不匹配409，不做 last-write-wins。」
 *
 * 与契约 `parameters.IfMatch.schema.pattern`（`^"[1-9][0-9]*"$`）严格同形。
 * 阶段 2 的路由层必须用本函数（而不是自己拼串）写 `ETag` 头，从而保证
 * 「不同资源状态不得共用同一强 ETag」在装配层也成立。
 */
export function strongEtagOf(revision: number): string {
  return `"${revision}"`;
}

export interface MessagesServiceDeps {
  store: MessagesStore;
  /**
   * 跳转目标可用性端口。**必填**：不提供默认值 —— 默认一个"未接线"端口会让
   * 调用方忘记接线却看起来一切正常；要求显式传入，接线与否在构造处可见。
   */
  reference: MessageReferencePort;
  /** 签名密钥（游标签名 + 幂等请求摘要 HMAC）；只在内存使用，不落库、不入日志。 */
  signingKey: string;
  now?: () => Date;
  newId?: () => string;
  idempotencyTtlMs?: number;
  idempotencyWaitMs?: number;
}

export interface WriteOptions {
  idempotencyKey?: string;
  ifMatch?: string;
}

/** 内部创建口结果（内部形状，**不是**契约 schema）。 */
export interface AppendMessageResult {
  /** 本次是否真的新建；`false` = 命中去重键，未重复创建。 */
  created: boolean;
  /** 该去重键当前的消息记录（**可能已是已读**，去重不会重置读状态）。 */
  message: MessageRecord;
}

/** 契约 `404 NOT_FOUND`：他人消息与不存在**共用这一个**错误，形状逐字节相同。 */
function notFound(): ApiError {
  return new ApiError('NOT_FOUND', '消息不存在或不可用');
}

/**
 * CAS 失败的契约映射：
 *   - `NOT_FOUND` / `OWNER_CHANGED` ⇒ 404 `NOT_FOUND`（不泄露存在性：非本人永远拿不到 409）；
 *   - `REVISION_CHANGED` ⇒ 409 `REVISION_CONFLICT`（客户端 `If-Match` 依据的视图已过期）。
 * 两者都在契约错误码闭集内。
 */
function commitRefusal(reason: 'NOT_FOUND' | 'OWNER_CHANGED' | 'REVISION_CHANGED'): ApiError {
  switch (reason) {
    case 'NOT_FOUND':
    case 'OWNER_CHANGED':
      return notFound();
    case 'REVISION_CHANGED':
      return new ApiError('REVISION_CONFLICT', '消息版本已变化，请刷新后重试');
  }
}

interface CursorPayload {
  v: 1;
  kind: 'messages';
  /** 调用方主体：防止一个用户复用别人的游标（游标由服务端签名，客户端改不动）。 */
  subject: string;
  auth_epoch: number;
  /** Immutable row identities/creation times; read-state updates do not invalidate a page chain. */
  watermark: string;
  route: 'messages';
  /** 过滤器（`GET /messages` 契约上没有筛选参数 ⇒ 恒为 `{}`，仍逐字节参与校验）。 */
  filter: Record<string, string>;
  sort: 'created_at_desc';
  after: { created_at: string; id: string };
  expires: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createMessagesService(deps: MessagesServiceDeps) {
  const store = deps.store;
  const reference = deps.reference;
  const signingKey = deps.signingKey;
  const clock = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  const idempotencyTtlMs = deps.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
  const idempotencyWaitMs = deps.idempotencyWaitMs ?? IDEMPOTENCY_WAIT_MS;

  const nowIso = (): string => clock().toISOString();
  const sign = (value: string): string => createHmac('sha256', signingKey).update('messages-list/v1\n').update(value).digest('base64url');

  // -------------------------------------------------------------------------
  // 幂等：先原子占位 → produce → 写回结果；失败释放占位；同键异体 409
  // -------------------------------------------------------------------------

  async function withIdempotency<T>(
    scope: string,
    keyHash: string,
    requestDigest: string,
    responseStatus: number,
    produce: () => Promise<{ outcome: IdempotencyOutcome; result: T }>,
    replay: (ref: IdempotencyOutcome) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await store.findIdempotency(scope, keyHash);
      if (existing !== null) {
        // 同键异体（含 If-Match 变了）⇒ 409，绝不回放另一份请求的结果。
        if (existing.request_hash !== requestDigest) {
          throw new ApiError('IDEMPOTENCY_CONFLICT', '同键请求内容不一致');
        }
        // 重放：按结果引用**重新读取并重新鉴权**（重新派生 reference_state），不回放旧响应。
        return replay(existing.outcome);
      }
      const claimed = await store.claimIdempotency(scope, keyHash, {
        request_hash: requestDigest,
        response_status: responseStatus,
        expires_at: clock().getTime() + idempotencyTtlMs,
      });
      if (!claimed) {
        const settled = await store.awaitIdempotencySettled(scope, keyHash, idempotencyWaitMs);
        if (settled === 'timeout') {
          throw new ApiError('REQUEST_IN_PROGRESS', '同键请求正在处理中，请稍后重试', { retryable: true });
        }
        continue;
      }
      let produced: { outcome: IdempotencyOutcome; result: T };
      try {
        produced = await produce();
      } catch (error) {
        // 失败释放占位：不留"半成品结果"，也不让同键重试被永久挡住。
        await store.releaseIdempotency(scope, keyHash);
        throw error;
      }
      const saved = await store.completeIdempotency(scope, keyHash, {
        response_status: responseStatus,
        outcome: produced.outcome,
      });
      if (saved) return produced.result;
      // 占位被他人完成/释放（理论上不出现）：回到循环按台账重放，不重复落库。
    }
    throw new ApiError('REQUEST_IN_PROGRESS', '同键请求正在处理中，请稍后重试', { retryable: true });
  }

  // -------------------------------------------------------------------------
  // 引用可用性（每次读取派生；fail-closed）
  // -------------------------------------------------------------------------

  /**
   * 派生 `reference_state`。
   *
   * 三道保守取值（任一命中即 `unavailable`）：
   *   1. `target_ref === null`：**没有可核验的目标** ⇒ 拿不到"目标当前对本人可用"的
   *      正证据，按 fail-closed 取保守值（契约只允许二值，`unavailable` 是保守侧）。
   *      依据：`docs/architecture/state-contract.md`「消息只存事件类型与对象引用」——
   *      没有引用就没有"可跳转"这一事实可陈述。
   *   2. 端口声明 `available !== true`（未接线）：即使其 `stateOf` 返回 `available`
   *      也不采信（冗余的第二道边界，防止"注入了一个假的可用端口"）。
   *   3. 端口返回非 `available` 的一切（含抛错被端口折叠后的结果）。
   *
   * 本函数**只**产出闭集取值，不产出任何目标侧内容或存在性信息。
   */
  async function referenceStateFor(record: MessageRecord, userId: string): Promise<ReferenceState> {
    if (record.target_ref === null) return 'unavailable';
    if (reference.available !== true) return 'unavailable';
    const state = await reference.stateOf({ target_ref: cloneDeep(record.target_ref), userId });
    return state === 'available' ? 'available' : 'unavailable';
  }

  /**
   * 契约 `Message` 投影。字段顺序与契约一致；`target_ref` 深拷贝；
   * `reference_state` **逐次重查**（列表/详情/重放都会重新派生，不做缓存）。
   */
  async function projectMessage(record: MessageRecord, userId: string): Promise<Message> {
    return {
      id: record.id,
      revision: record.revision,
      type: record.type,
      target_ref: record.target_ref === null ? null : cloneDeep(record.target_ref),
      reference_state: await referenceStateFor(record, userId),
      read_at: record.read_at,
      created_at: record.created_at,
    };
  }

  // -------------------------------------------------------------------------
  // 游标（签名 + 绑定主体/路由/过滤/排序；防篡改与跨主体复用）
  // -------------------------------------------------------------------------

  function encodeCursor(payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${sign(body)}`;
  }

  function decodeCursor(
    cursor: string | null,
    expected: Omit<CursorPayload, 'after' | 'expires'>,
  ): Pick<CursorPayload, 'after' | 'expires'> | null {
    if (cursor === null) return null;
    try {
      const parts = cursor.split('.');
      if (parts.length !== 2) throw new Error('shape');
      const body = parts[0];
      const signature = parts[1];
      if (typeof body !== 'string' || typeof signature !== 'string' || body.length === 0) throw new Error('shape');
      const decoded = Buffer.from(body, 'base64url');
      if (decoded.toString('base64url') !== body || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new Error('encoding');
      const expectedSignature = Buffer.from(sign(body), 'base64url');
      const received = Buffer.from(signature, 'base64url');
      if (received.toString('base64url') !== signature) throw new Error('encoding');
      if (received.length !== expectedSignature.length || !timingSafeEqual(expectedSignature, received)) {
        throw new Error('signature');
      }
      const value: unknown = JSON.parse(decoded.toString('utf8'));
      const keys = ['v', 'kind', 'subject', 'auth_epoch', 'watermark', 'route', 'filter', 'sort', 'after', 'expires'];
      if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('fields');
      if (value['v'] !== 1 || value['auth_epoch'] !== expected.auth_epoch || value['watermark'] !== expected.watermark) throw new Error('version');
      if (value['kind'] !== expected.kind || value['route'] !== expected.route) throw new Error('scope');
      if (value['subject'] !== expected.subject) throw new Error('subject');
      if (value['sort'] !== expected.sort) throw new Error('sort');
      if (JSON.stringify(value['filter']) !== JSON.stringify(expected.filter)) throw new Error('filter');
      const expires = value['expires'];
      if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires <= clock().getTime()) {
        throw new Error('expired');
      }
      const after = value['after'];
      if (!isRecord(after) || Object.keys(after).length !== 2 || !Object.hasOwn(after, 'created_at') || !Object.hasOwn(after, 'id')) throw new Error('after');
      if (typeof after['created_at'] !== 'string' || typeof after['id'] !== 'string') throw new Error('after');
      return { after: { created_at: after['created_at'], id: after['id'] }, expires };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('INVALID_CURSOR', '游标无效或已失效');
    }
  }

  /** 游标（只由本服务签发/验签）；长度上限由 `parseCursor` 按契约 `Cursor.maxLength` 把守。 */
  return {
    /** `listMessages`：`GET /messages`。只列本人消息；`(created_at DESC, id DESC)` 稳定排序。 */
    async listMessages(actor: unknown, query: unknown = {}): Promise<MessagePage> {
      const user = requireUserActor(actor);
      const { cursor, limit } = parseListMessagesQuery(query);
      const rows = await store.listMessagesByOwner(user.userId);
      const sorted = [...rows].sort(compareMessagesDescending);
      const expected: Omit<CursorPayload, 'after' | 'expires'> = {
        v: 1,
        kind: 'messages',
        subject: user.userId,
        auth_epoch: user.authEpoch,
        watermark: createHmac('sha256', signingKey).update('messages-watermark/v1\n')
          .update(JSON.stringify(sorted.map(row => [row.id, row.created_at]))).digest('base64url'),
        route: 'messages',
        filter: {},
        sort: 'created_at_desc',
      };
      const chain = decodeCursor(cursor, expected);
      const after = chain?.after ?? null;
      if (after !== null && !sorted.some(row => row.id === after.id && row.created_at === after.created_at)) {
        throw new ApiError('INVALID_CURSOR', '游标位置已失效，请重新读取首页');
      }
      const expires = chain?.expires ?? clock().getTime() + CURSOR_TTL_MS;
      // 稳定游标：同 `created_at` 用 `id` 全序兜底 ⇒ 同刻多条不漏不重。
      const remaining =
        after === null
          ? sorted
          : sorted.filter(
              (record) =>
                record.created_at < after.created_at ||
                (record.created_at === after.created_at && record.id < after.id),
            );
      const page = remaining.slice(0, limit);
      const last = page[page.length - 1];
      const next_cursor =
        remaining.length > limit && last !== undefined
          ? encodeCursor({
              ...expected,
              after: { created_at: last.created_at, id: last.id },
              expires,
            })
          : null;
      const items: Message[] = [];
      for (const record of page) items.push(await projectMessage(record, user.userId));
      return { items, next_cursor };
    },

    /** `getUnreadCount`：`GET /messages/unread-count`。**派生**值，非计数器。 */
    async getUnreadCount(actor: unknown): Promise<UnreadCount> {
      const user = requireUserActor(actor);
      return { count: await store.countUnread(user.userId) };
    },

    /**
     * `markMessageRead`：`PUT /messages/{id}/read`。
     *
     * - 归属：非本人（含不存在）一律 404 `NOT_FOUND`，同形；
     * - `If-Match`：缺失 428、格式非法 400、**与目标当前 `revision` 不符 409**（不做 last-write-wins）；
     * - 首次读转换：由存储层 CAS 在同一同步临界区内完成（并发只发生一次 `null → 时刻`）
     *   ⇒ **`revision` 恰好 +1**，返回的强 ETag `"<revision>"` 随之变化；
     * - 重复标记（携带**当前** ETag）：**空操作** ⇒ `revision` 与 `read_at` 均不变、未读不再减；
     * - 首次标记之后的**旧 ETag** 不再匹配 ⇒ 409（不得静默通过）。
     */
    async markMessageRead(actor: unknown, id: unknown, options: WriteOptions = {}): Promise<Message> {
      const user = requireUserActor(actor);
      const messageId = requireUuidParam(id, 'id');
      const key = requireIdempotencyKey(options.idempotencyKey);
      const ifMatch = requireIfMatch(options.ifMatch);
      const scope = idempotencyScope(user.userId, 'PUT', `/messages/${messageId}/read`);
      const keyHash = idempotencyKeyHashHex(scope, key);
      // 该 PUT 契约上没有请求体：摘要只含 If-Match。
      const digest = idempotencyRequestHash(null, options.ifMatch, signingKey);
      return withIdempotency(
        scope,
        keyHash,
        digest,
        200,
        async () => {
          const record = await store.getMessage(messageId);
          // 归属与"不存在"同形：非本人**不得**得到 409（那会泄露"存在但不是你的"）。
          if (record === null || record.owner_id !== user.userId) throw notFound();
          if (record.revision !== ifMatch.revision) {
            throw new ApiError('REVISION_CONFLICT', '消息版本已变化，请刷新后重试');
          }
          // 检查（归属/revision）与写入在**同一原子临界区**内再次完成，
          // `record`（旧快照）只用于给出"期望值"，不用于写回。
          const committed: MarkReadResult = await store.markReadIfUnread(
            messageId,
            { revision: record.revision, owner_id: user.userId },
            nowIso(),
          );
          if (!committed.ok) throw commitRefusal(committed.reason);
          return {
            outcome: { kind: 'message' as const, id: messageId, revision: committed.record.revision },
            result: await projectMessage(committed.record, user.userId),
          };
        },
        async (ref) => {
          const record = await store.getMessage(ref.id);
          // 重放同样重新鉴权（不重放旧可见正文；reference_state 也是重新派生的）。
          if (record === null || record.owner_id !== user.userId) throw notFound();
          return projectMessage(record, user.userId);
        },
      );
    },

    // -----------------------------------------------------------------------
    // 内部操作（**不是**契约 operationId；无 HTTP 入口，阶段 2 由审核/社区/系统接线调用）
    // -----------------------------------------------------------------------

    /**
     * 内部创建口：把一条系统事件落成接收者的一条消息。
     *
     * - **不注册路由**、不进契约；`owner_id`/`event_key` 由服务端调用方给出，
     *   绝不来自客户端（否则等于允许伪造他人消息 / 真人互动）；
     * - `read_at` 恒为 `null`（"发送或创建不当作已读"）；入参里的 `read_at`/`id`/`revision`
     *   /`reference_state` 一律被拒（`UNKNOWN_FIELD`）；
     * - 同 `(owner_id, event_key)` 只存在一条：重复调度返回既有记录且**不重置读状态**；
     *   并发同键时由存储层的去重索引保证**恰好一次生效**。
     */
    async appendMessage(input: unknown): Promise<AppendMessageResult> {
      const body = validateAppendMessageInput(input);
      const existing = await store.findByEventKey(body.owner_id, body.event_key);
      if (existing !== null) return { created: false, message: existing };
      const record: MessageRecord = {
        id: newId(),
        revision: 1,
        owner_id: body.owner_id,
        type: body.type,
        target_ref: body.target_ref === null ? null : cloneDeep(body.target_ref),
        read_at: null,
        created_at: nowIso(),
        event_key: body.event_key,
      };
      const inserted = await store.insertMessage(record);
      if (inserted === 'inserted') return { created: true, message: cloneDeep(record) };
      // 并发同键：另一次插入先赢，回读既有记录（不产生第二条消息）。
      const raced = await store.findByEventKey(body.owner_id, body.event_key);
      if (raced === null) {
        throw new ApiError('PROVIDER_UNAVAILABLE', '消息去重索引不一致（内部不变式违反）');
      }
      return { created: false, message: raced };
    },
  };
}

export type MessagesService = ReturnType<typeof createMessagesService>;
